const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { requireStudentAuth } = require('../middleware/auth');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Student = require('../models/Student');
const ExamSettings = require('../models/ExamSettings');
const { executeCode } = require('../utils/codeExecutor');

// ─── Get Questions (student view - no test cases) ──────────────────────────────
router.get('/questions', requireStudentAuth, async (req, res) => {
  try {
    if (req.student.status === 'submitted' || req.student.status === 'auto_submitted') {
      return res.status(403).json({ error: 'Exam already submitted' });
    }
    const questions = await Question.find({ isActive: true }).sort({ order: 1 });
    const studentView = questions.map(q => q.toStudentView());
    res.json({ success: true, questions: studentView });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load questions' });
  }
});

// ─── RUN Code against sample input only ───────────────────────────────────────
router.post('/run',
  requireStudentAuth,
  [
    body('code').isString().isLength({ min: 1, max: 50000 }),
    body('language').isIn(['python', 'javascript', 'java', 'c', 'cpp']),
    body('questionId').isString().notEmpty(),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid input' });
    }
    const { code, language, questionId } = req.body;
    try {
      if (req.student.status === 'submitted' || req.student.status === 'auto_submitted') {
        return res.status(403).json({ success: false, message: 'Exam already submitted' });
      }
      const question = await Question.findById(questionId).select('sampleInput sampleOutput');
      if (!question) return res.status(404).json({ success: false, message: 'Question not found' });

      const settings = await ExamSettings.findOne({ singleton: 'settings' });
      const timeout = settings?.executionTimeoutMs || 5000;

      const sampleTC = [{ _id: 'sample', input: question.sampleInput, expectedOutput: question.sampleOutput, marks: 0 }];
      const { results, error } = await executeCode(code, language, sampleTC, timeout);

      if (error) return res.json({ success: false, output: error, error });

      const r = results[0] || {};
      return res.json({
        success: true,
        output: r.error ? r.error : (r.stdout || '(no output)'),
        error: r.error || null,
        timedOut: r.timedOut || false,
        passed: r.passed || false,
      });
    } catch (err) {
      console.error('Run error:', err);
      return res.status(500).json({ success: false, message: 'Execution failed' });
    }
  }
);

// ─── SUBMIT Code for a Question (hidden test cases) ───────────────────────────
router.post('/submit/:questionId',
  requireStudentAuth,
  [
    body('code').isString().isLength({ min: 1, max: 50000 }),
    body('language').optional().isIn(['python', 'javascript', 'java', 'c', 'cpp']),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid input' });
    const { code, language = 'python' } = req.body;
    const { questionId } = req.params;
    try {
      if (req.student.status === 'submitted' || req.student.status === 'auto_submitted') {
        return res.status(403).json({ error: 'Exam already submitted' });
      }
      const elapsed = Date.now() - req.session.examStart;
      if (elapsed > req.session.durationMs) return res.status(403).json({ error: 'Exam time has expired' });

      const question = await Question.findById(questionId);
      if (!question || !question.isActive) return res.status(404).json({ error: 'Question not found' });

      const settings = await ExamSettings.findOne({ singleton: 'settings' });
      const timeout = settings?.executionTimeoutMs || 5000;

      const { results, error } = await executeCode(code, language, question.testCases, timeout);
      if (error) return res.status(400).json({ error });

      const testCasesPassed = results.filter(r => r.passed).length;
      const score = results.reduce((sum, r) => sum + r.marks, 0);
      const total = question.testCases.length;

      await Submission.findOneAndUpdate(
        { student: req.student._id, question: questionId },
        {
          student: req.student._id, question: questionId, code, language,
          testResults: results, testCasesPassed, totalTestCases: total,
          score, maxScore: question.totalMarks, submittedAt: new Date(), executionStatus: 'completed',
        },
        { upsert: true, new: true }
      );

      // Safe results — no marks, no expected output shown
      const safeResults = results.map((r, i) => ({
        index: i + 1,
        passed: r.passed,
        error: r.passed ? null : (r.error || 'Wrong Answer'),
      }));

      res.json({ success: true, passed: testCasesPassed, total, results: safeResults });
    } catch (err) {
      console.error('Submission error:', err);
      res.status(500).json({ error: 'Submission failed' });
    }
  }
);

// ─── Final Exam Submit ──────────────────────────────────────────────────────────
router.post('/final-submit', requireStudentAuth, async (req, res) => {
  try {
    if (req.student.status === 'submitted' || req.student.status === 'auto_submitted') {
      return res.status(200).json({ success: true, message: 'Already submitted' });
    }
    req.student.status = req.body.autoSubmit ? 'auto_submitted' : 'submitted';
    req.student.examSubmittedAt = new Date();
    req.student.isLoggedIn = false;
    req.student.sessionId = null;
    if (req.body.autoSubmit && req.body.reason) req.student.autoSubmitReason = req.body.reason;
    await req.student.save();
    req.session.destroy();
    res.json({ success: true, message: 'Your response has been recorded.' });
  } catch (err) {
    res.status(500).json({ error: 'Submit failed' });
  }
});

// ─── Log Violation ──────────────────────────────────────────────────────────────
router.post('/violation', requireStudentAuth,
  [body('type').isIn(['fullscreen_exit', 'tab_switch', 'right_click', 'keyboard_shortcut', 'copy_paste', 'other'])],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid' });
    const { type, details } = req.body;
    try {
      req.student.addViolation(type, details);
      await req.student.save();
      const settings = await ExamSettings.findOne({ singleton: 'settings' });
      const maxViolations = settings?.maxViolationsBeforeSubmit || 2;
      const typeViolation = req.student.violations.find(v => v.type === type);
      const typeCount = typeViolation ? typeViolation.count : 0;
      let shouldAutoSubmit = false, warningMessage = null;
      if ((type === 'fullscreen_exit' || type === 'tab_switch') && typeCount >= maxViolations) {
        shouldAutoSubmit = true;
      } else if (typeCount === 1) {
        warningMessage = type === 'fullscreen_exit'
          ? 'WARNING: You exited fullscreen. Next violation will auto-submit your exam.'
          : 'WARNING: Tab switching detected. Next violation will auto-submit your exam.';
      }
      res.json({ success: true, shouldAutoSubmit, warningMessage, violationCount: typeCount });
    } catch (err) {
      res.status(500).json({ error: 'Failed to log violation' });
    }
  }
);

// ─── Get Exam Settings ─────────────────────────────────────────────────────────
router.get('/settings', requireStudentAuth, async (req, res) => {
  try {
    const settings = await ExamSettings.findOne({ singleton: 'settings' });
    const elapsed = Date.now() - req.session.examStart;
    const remaining = Math.max(0, (req.session.durationMs || 3600000) - elapsed);
    res.json({
      durationMinutes: settings?.durationMinutes || 60,
      remainingMs: remaining,
      languages: settings?.allowedLanguages || ['python', 'javascript', 'java', 'c', 'cpp'],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

module.exports = router;
