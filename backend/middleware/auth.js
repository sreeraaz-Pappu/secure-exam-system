const Student = require('../models/Student');

const requireStudentAuth = async (req, res, next) => {
  if (!req.session || !req.session.studentId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const student = await Student.findById(req.session.studentId);
    if (!student) return res.status(401).json({ error: 'Session invalid' });
    if (!student.isLoggedIn) return res.status(401).json({ error: 'Session expired' });
    if (student.sessionId !== req.session.sessionId) {
      return res.status(401).json({ error: 'Multiple sessions detected', code: 'MULTI_SESSION' });
    }
    req.student = student;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth error' });
  }
};

const requireAdminAuth = (req, res, next) => {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = { requireStudentAuth, requireAdminAuth };
