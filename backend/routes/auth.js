const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Student = require('../models/Student');
const ExamSettings = require('../models/ExamSettings');
const { requireStudentAuth, requireAdminAuth } = require('../middleware/auth');

// ─── Student Login ─────────────────────────────────────────────────────────────
router.post('/student/login',
  [
    body('rollNumber').trim().isLength({ min: 1, max: 20 }).matches(/^[A-Z0-9a-z\-_]+$/),
    body('fullName').trim().isLength({ min: 2, max: 100 }).matches(/^[a-zA-Z\s.'-]+$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });

    const { rollNumber, fullName } = req.body;
    const rollUpper = rollNumber.toUpperCase();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
      // Check exam is active
      const settings = await ExamSettings.findOne({ singleton: 'settings' });
      if (!settings || !settings.isActive) {
        return res.status(403).json({ error: 'Exam is not active. Please wait for the exam to begin.' });
      }

      // Check exam time window
      const now = new Date();
      if (settings.startTime && now < settings.startTime) {
        return res.status(403).json({ error: 'Exam has not started yet.' });
      }
      if (settings.endTime && now > settings.endTime) {
        return res.status(403).json({ error: 'Exam time has ended.' });
      }

      let student = await Student.findOne({ rollNumber: rollUpper });

      if (student) {
        // Validate name matches
        if (student.fullName.toLowerCase() !== fullName.toLowerCase().trim()) {
          return res.status(401).json({ error: 'Name does not match records for this Roll Number.' });
        }
        // Check if already attempted
        if (student.hasAttempted) {
          return res.status(403).json({ error: 'You have already attempted this exam. Only one attempt is allowed.' });
        }
        // Check if already logged in (duplicate session)
        if (student.isLoggedIn && student.sessionId) {
          return res.status(403).json({ error: 'Another session is already active for this Roll Number.' });
        }
      } else {
        // New student - create record
        student = new Student({
          rollNumber: rollUpper,
          fullName: fullName.trim(),
        });
      }

      const sessionId = uuidv4();
      student.ipAddress = ip;
      student.loginTime = now;
      student.examStartTime = now;
      student.isLoggedIn = true;
      student.sessionId = sessionId;
      student.hasAttempted = true;
      student.status = 'in_exam';
      await student.save();

      req.session.studentId = student._id.toString();
      req.session.sessionId = sessionId;
      req.session.examStart = now.getTime();
      req.session.durationMs = (settings.durationMinutes || 60) * 60 * 1000;

      res.json({ success: true, student: { rollNumber: student.rollNumber, fullName: student.fullName } });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ─── Student Logout / Status ───────────────────────────────────────────────────
router.get('/student/status', requireStudentAuth, (req, res) => {
  const elapsed = Date.now() - req.session.examStart;
  const remaining = Math.max(0, req.session.durationMs - elapsed);
  res.json({
    loggedIn: true,
    rollNumber: req.student.rollNumber,
    fullName: req.student.fullName,
    remainingMs: remaining,
    status: req.student.status,
  });
});

// ─── Admin Login ───────────────────────────────────────────────────────────────
router.post('/admin/login',
  [
    body('username').trim().isLength({ min: 1, max: 50 }),
    body('password').isLength({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });

    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'Admin@SecureExam2024!';

    if (username !== adminUser || password !== adminPass) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.isAdmin = true;
    req.session.adminUsername = username;
    res.json({ success: true });
  }
);

router.post('/admin/logout', requireAdminAuth, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/admin/status', requireAdminAuth, (req, res) => {
  res.json({ loggedIn: true, username: req.session.adminUsername });
});

module.exports = router;
