# 🔒 Secure Online Coding Examination System

A production-ready, full-stack secure examination portal with anti-cheat enforcement, sandboxed code execution, and full admin control.

---

## 📁 Project Structure

```
secure-exam/
├── backend/
│   ├── server.js              # Express app entry point
│   ├── package.json
│   ├── .env.example           # Environment variables template
│   ├── routes/
│   │   ├── auth.js            # Student & admin login/logout
│   │   ├── exam.js            # Questions, submission, violations
│   │   └── admin.js           # Admin CRUD, results, export
│   ├── models/
│   │   ├── Student.js         # Student with violation tracking
│   │   ├── Question.js        # Questions with hidden test cases
│   │   ├── Submission.js      # Code submissions & scores
│   │   └── ExamSettings.js    # Exam configuration
│   ├── middleware/
│   │   └── auth.js            # Session-based auth guards
│   └── utils/
│       ├── codeExecutor.js    # Sandboxed code runner (Python/JS)
│       └── seed.js            # Database seeder (sample data)
│
└── frontend/
    ├── shared/
    │   └── styles.css         # Global design system
    ├── student/
    │   ├── login.html         # Student login
    │   └── exam.html          # Exam interface (editor + anti-cheat)
    └── admin/
        ├── login.html         # Admin login
        ├── admin.css          # Admin panel styles
        ├── dashboard.html     # Overview + settings
        ├── questions.html     # Question & test case management
        ├── results.html       # Student scores + code viewer
        └── monitor.html       # Live student status (auto-refresh)
```

---

## ⚡ Quick Setup

### Prerequisites
- **Node.js** v18+
- **MongoDB** (local or Atlas)
- **Python 3** (for Python code execution)

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
MONGODB_URI=mongodb://localhost:27017/secure_exam
SESSION_SECRET=your_very_long_random_secret_here_change_this
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YourStrongPassword123!
EXAM_DURATION_MINUTES=60
CODE_EXECUTION_TIMEOUT=3000
NODE_ENV=production
```

⚠️ **CRITICAL**: Change `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` before deploying!

### 3. Seed the Database

```bash
npm run seed
```

This creates:
- Default exam settings (60 min, Python, inactive)
- 3 sample coding questions with test cases

### 4. Start the Server

```bash
npm start
# or for development:
npm run dev
```

Server runs at `http://localhost:5000`

---

## 🔑 Access Points

| URL | Description |
|-----|-------------|
| `http://localhost:5000/` | Student login |
| `http://localhost:5000/exam` | Student exam interface |
| `http://localhost:5000/admin` | Admin login |
| `http://localhost:5000/admin/dashboard` | Admin dashboard |
| `http://localhost:5000/admin/questions` | Manage questions |
| `http://localhost:5000/admin/results` | View results |
| `http://localhost:5000/admin/monitor` | Live monitor |

---

## 🎯 Exam Workflow

### Admin Setup (Before Exam)
1. Login to `/admin` with your credentials
2. Go to **Questions** → Add 3 coding questions with hidden test cases
3. Go to **Dashboard** → Set exam duration and language
4. Toggle **Exam Active = true** when ready to start

### Student Flow
1. Student visits `/` → enters Roll Number + Full Name
2. Prompted to enter **fullscreen** before exam begins
3. Timer starts immediately on login
4. Student writes code in editor, clicks **Run & Submit** per question
5. On final submit (or timeout) → "Your response has been recorded."

### Post-Exam (Admin)
1. Go to **Results** → view scores sorted by highest marks
2. Click any student row to expand and **view their code**
3. Export to Excel via the export button

---

## 🛡️ Security Features

### Anti-Cheat
| Trigger | Action |
|---------|--------|
| Exit fullscreen (1st) | Warning shown |
| Exit fullscreen (2nd) | Auto-submit |
| Tab switch (1st) | Warning shown |
| Tab switch (2nd) | Auto-submit |
| Right-click | Blocked + logged |
| Ctrl+C/V/X | Blocked + logged |
| F12 / Ctrl+Shift+I | Blocked + logged |
| Ctrl+U (view source) | Blocked |
| F5 / Ctrl+R (refresh) | Blocked |
| Back navigation | Blocked |

### Code Execution Security
- **Pattern blacklist**: Blocks `import os`, `subprocess`, `open()`, `eval()`, `exec()`, `__import__`, network access, file I/O
- **Process isolation**: Each submission runs as a child process
- **Memory limit**: 64MB RAM cap via `resource.setrlimit`
- **File write limit**: 0 bytes (no file creation)
- **Process limit**: No subprocess spawning
- **Timeout**: 3 seconds default (configurable)
- **Output cap**: 10,000 characters max

### Application Security
- Helmet.js (CSP, XSS headers, clickjacking prevention)
- MongoDB sanitization (NoSQL injection prevention)
- XSS-Clean middleware
- Rate limiting on auth endpoints (20 req/15min)
- Session-based auth with HttpOnly cookies
- Input validation via express-validator
- One session per student (duplicate session detection)
- All evaluation server-side only

---

## 📊 Database Schema Overview

### Student
```
rollNumber (unique), fullName, ipAddress, loginTime, examStartTime,
examSubmittedAt, hasAttempted, isLoggedIn, sessionId, status,
violations[], totalViolations, autoSubmitted, autoSubmitReason
```

### Question
```
order, title, description, inputFormat, outputFormat, constraints,
sampleInput, sampleOutput, testCases[], totalMarks, isActive
```

### TestCase (embedded in Question)
```
input, expectedOutput, marks, isHidden, description
```

### Submission
```
student (ref), question (ref), code, language, testResults[],
testCasesPassed, totalTestCases, score, maxScore, submittedAt, executionStatus
```

---

## 🚀 Production Deployment

### Using PM2

```bash
npm install -g pm2
cd backend
pm2 start server.js --name secure-exam
pm2 save
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name your-exam-domain.com;
    
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then add SSL with Certbot:
```bash
certbot --nginx -d your-exam-domain.com
```

### MongoDB Atlas (Cloud)

Replace `MONGODB_URI` in `.env`:
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/secure_exam
```

---

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `EXAM_DURATION_MINUTES` | 60 | Exam length |
| `CODE_EXECUTION_TIMEOUT` | 3000 | Max execution time in ms |
| `NODE_ENV` | production | Set to `production` for secure cookies |
| `SESSION_SECRET` | — | **Must change** — long random string |

---

## 🔧 Adding Questions via Admin Panel

1. Login to `/admin`
2. Navigate to **Questions**
3. Click **+ Add Question**
4. Fill in:
   - **Order**: 1, 2, or 3
   - **Title**: Short question name
   - **Description**: Full problem statement
   - **Input/Output Format**: Describe format
   - **Constraints**: e.g. `1 ≤ n ≤ 10^9`
   - **Sample Input/Output**: Shown to student
   - **Test Cases**: Hidden from students — input, expected output, marks per case
5. Save

---

## 📝 Notes

- **Supported languages**: Python 3 and JavaScript (Node.js). Set in Exam Settings.
- **Test case output matching**: Normalized (whitespace-trimmed, newline-standardized)
- **One attempt only**: Once a student logs in, their `hasAttempted` is permanently set to `true`
- **Code is NOT returned to students**: They never see pass/fail results
- **Admin password**: Stored in `.env` as plaintext — use a strong password and restrict server access

---

## 🛠️ Troubleshooting

**Python3 not found:**
```bash
which python3  # Should return /usr/bin/python3
sudo apt install python3  # Ubuntu/Debian
```

**MongoDB connection refused:**
```bash
sudo systemctl start mongod
# or for Atlas: check IP whitelist and connection string
```

**Port already in use:**
```bash
PORT=3000 npm start
```

**Session not persisting:**
- Ensure `SESSION_SECRET` is set in `.env`
- In production, ensure `NODE_ENV=production` (enables secure cookies over HTTPS)
