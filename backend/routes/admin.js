const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { requireAdminAuth } = require('../middleware/auth');
const Student = require('../models/Student');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const ExamSettings = require('../models/ExamSettings');
const XLSX = require('xlsx');

// All admin routes require auth
router.use(requireAdminAuth);

// ─── Exam Settings ─────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const s = await ExamSettings.findOne({ singleton: 'settings' });
  res.json(s || {});
});

router.put('/settings',
  [
    body('durationMinutes').isInt({ min: 1, max: 480 }),
    body('isActive').isBoolean(),
    body('allowedLanguages').isArray(),
    body('executionTimeoutMs').isInt({ min: 1000, max: 30000 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid settings' });
    const settings = await ExamSettings.findOneAndUpdate(
      { singleton: 'settings' },
      { ...req.body, singleton: 'settings' },
      { upsert: true, new: true }
    );
    res.json(settings);
  }
);

// ─── Questions CRUD ────────────────────────────────────────────────────────────
router.get('/questions', async (req, res) => {
  const questions = await Question.find().sort({ order: 1 });
  res.json({ questions });
});

router.get('/questions/:id', async (req, res) => {
  const q = await Question.findById(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json(q);
});

router.post('/questions',
  [
    body('order').isInt({ min: 1, max: 20 }),
    body('title').trim().isLength({ min: 1, max: 200 }),
    body('description').trim().isLength({ min: 1, max: 5000 }),
    body('inputFormat').trim().isLength({ min: 1, max: 1000 }),
    body('outputFormat').trim().isLength({ min: 1, max: 1000 }),
    body('constraints').trim().isLength({ min: 1, max: 1000 }),
    body('testCases').isArray({ min: 1 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid question data' });
    try {
      const q = new Question(req.body);
      await q.save();
      res.status(201).json(q);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put('/questions/:id', async (req, res) => {
  try {
    const q = await Question.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/questions/:id', async (req, res) => {
  await Question.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ─── Students / Results ────────────────────────────────────────────────────────
router.get('/students', async (req, res) => {
  const students = await Student.find().sort({ createdAt: -1 }).lean();
  res.json({ students });
});

router.get('/results', async (req, res) => {
  try {
    const students = await Student.find({ hasAttempted: true }).sort({ createdAt: -1 }).lean();
    const submissions = await Submission.find().populate('question', 'order title totalMarks').lean();

    // Build results per student
    const results = await Promise.all(students.map(async (s) => {
      const subs = submissions.filter(sub => sub.student.toString() === s._id.toString());
      const totalScore = subs.reduce((sum, sub) => sum + sub.score, 0);
      const maxScore = subs.reduce((sum, sub) => sum + sub.maxScore, 0);

      return {
        _id: s._id,
        rollNumber: s.rollNumber,
        fullName: s.fullName,
        ipAddress: s.ipAddress,
        loginTime: s.loginTime,
        submittedAt: s.examSubmittedAt,
        status: s.status,
        totalViolations: s.totalViolations,
        autoSubmitted: s.autoSubmitted,
        totalScore,
        maxScore,
        submissions: subs.map(sub => ({
          questionOrder: sub.question?.order,
          questionTitle: sub.question?.title,
          testCasesPassed: sub.testCasesPassed,
          totalTestCases: sub.totalTestCases,
          score: sub.score,
          maxScore: sub.maxScore,
          submittedAt: sub.submittedAt,
          language: sub.language,
        })),
      };
    }));

    // Sort by total score descending
    results.sort((a, b) => b.totalScore - a.totalScore);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// View individual student code
router.get('/results/:studentId/code/:questionId', async (req, res) => {
  const sub = await Submission.findOne({
    student: req.params.studentId,
    question: req.params.questionId,
  }).populate('question', 'title order');
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

// ─── Live Monitor ──────────────────────────────────────────────────────────────
router.get('/monitor', async (req, res) => {
  const students = await Student.find({ hasAttempted: true })
    .select('rollNumber fullName status totalViolations isLoggedIn examStartTime loginTime')
    .sort({ loginTime: -1 })
    .lean();
  res.json({ students, timestamp: new Date() });
});

// ─── Export to Excel ───────────────────────────────────────────────────────────
router.get('/export/results', async (req, res) => {
  try {
    const students = await Student.find({ hasAttempted: true }).lean();
    const submissions = await Submission.find().populate('question', 'order title').lean();
    const questions = await Question.find({ isActive: true }).sort({ order: 1 }).lean();

    const data = students.map(s => {
      const subs = submissions.filter(sub => sub.student.toString() === s._id.toString());
      const totalScore = subs.reduce((sum, sub) => sum + sub.score, 0);
      const row = {
        'Roll Number': s.rollNumber,
        'Full Name': s.fullName,
        'IP Address': s.ipAddress,
        'Login Time': s.loginTime ? new Date(s.loginTime).toLocaleString() : '',
        'Submitted At': s.examSubmittedAt ? new Date(s.examSubmittedAt).toLocaleString() : '',
        'Status': s.status,
        'Total Violations': s.totalViolations,
        'Auto Submitted': s.autoSubmitted ? 'Yes' : 'No',
        'Total Score': totalScore,
      };
      questions.forEach(q => {
        const sub = subs.find(s => s.question?._id?.toString() === q._id.toString());
        row[`Q${q.order} Score`] = sub ? sub.score : 0;
        row[`Q${q.order} Passed`] = sub ? `${sub.testCasesPassed}/${sub.totalTestCases}` : '0/0';
      });
      return row;
    });

    data.sort((a, b) => b['Total Score'] - a['Total Score']);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');

    // Login data sheet
    const loginData = students.map(s => ({
      'Roll Number': s.rollNumber,
      'Full Name': s.fullName,
      'IP Address': s.ipAddress,
      'Login Time': s.loginTime ? new Date(s.loginTime).toLocaleString() : '',
      'Status': s.status,
    }));
    const ws2 = XLSX.utils.json_to_sheet(loginData);
    XLSX.utils.book_append_sheet(wb, ws2, 'Login Data');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=exam_results_${Date.now()}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

router.get('/export/logins', async (req, res) => {
  const students = await Student.find().lean();
  const data = students.map(s => ({
    'Roll Number': s.rollNumber,
    'Full Name': s.fullName,
    'IP Address': s.ipAddress || '',
    'Login Time': s.loginTime ? new Date(s.loginTime).toLocaleString() : 'Not logged in',
    'Has Attempted': s.hasAttempted ? 'Yes' : 'No',
    'Status': s.status,
    'Total Violations': s.totalViolations,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Login Data');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=login_data.xlsx');
  res.send(buffer);
});

module.exports = router;
