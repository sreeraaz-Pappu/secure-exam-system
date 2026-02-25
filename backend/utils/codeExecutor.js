const { spawn, execSync } = require('child_process');
const { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync, readdirSync } = require('fs');
const { join } = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const TIMEOUT_MS = parseInt(process.env.CODE_EXECUTION_TIMEOUT) || 5000;
const TEMP_DIR = os.tmpdir();
const IS_WIN = process.platform === 'win32';

// ─── Auto-detect Java on Windows ──────────────────────────────────────────────
function findJavaCmd(bin) {
  if (!IS_WIN) return bin;

  // 1. Try PATH first
  try { execSync(`where ${bin}`, { stdio: 'pipe' }); return bin; } catch (_) {}

  // 2. Check JAVA_HOME env variable
  if (process.env.JAVA_HOME) {
    const p = join(process.env.JAVA_HOME, 'bin', `${bin}.exe`);
    if (existsSync(p)) return p;
  }

  // 3. Search common install folders
  const baseDirs = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\OpenJDK',
    'C:\\Program Files\\Amazon Corretto',
  ];

  for (const base of baseDirs) {
    if (!existsSync(base)) continue;
    try {
      const subdirs = readdirSync(base);
      for (const sub of subdirs) {
        const full = join(base, sub, 'bin', `${bin}.exe`);
        if (existsSync(full)) return full;
      }
    } catch (_) {}
  }

  return bin; // fallback
}

const JAVAC_CMD = IS_WIN ? 'C:\\Program Files\\Java\\jdk-23\\bin\\javac.exe' : 'javac';
const JAVA_CMD  = IS_WIN ? 'C:\\Program Files\\Java\\jdk-23\\bin\\java.exe' : 'java';
console.log(`[Executor] Java: javac="${JAVAC_CMD}"  java="${JAVA_CMD}"`);

// ─── Security Blacklists ───────────────────────────────────────────────────────

const PYTHON_FORBIDDEN = [
  /import\s+os\b/, /import\s+subprocess\b/,
  /import\s+socket\b/, /import\s+requests\b/, /import\s+urllib\b/,
  /import\s+shutil\b/, /import\s+pathlib\b/, /import\s+glob\b/,
  /import\s+importlib\b/, /import\s+ctypes\b/, /import\s+threading\b/,
  /import\s+multiprocessing\b/, /import\s+pickle\b/, /import\s+marshal\b/,
  /__import__/, /open\s*\(/, /exec\s*\(/, /eval\s*\(/, /compile\s*\(/,
  /globals\s*\(/, /locals\s*\(/, /vars\s*\(/, /getattr\s*\(/,
  /setattr\s*\(/, /delattr\s*\(/, /breakpoint\s*\(/,
];

const JAVA_FORBIDDEN = [
  /Runtime\.getRuntime\(\)/, /ProcessBuilder/, /System\.exit\s*\(/,
  /java\.io\.File/, /java\.net\./, /java\.nio\./, /Class\.forName/,
  /\.reflect\./, /SecurityManager/, /System\.load\s*\(/, /Runtime\.exec/,
  /new\s+Thread\s*\(/, /Executors\./, /java\.lang\.Process/,
];

const C_FORBIDDEN = [
  /\bsystem\s*\(/, /\bpopen\s*\(/, /\bexecl\b/, /\bexeclp\b/, /\bexecv\b/,
  /\bexecvp\b/, /\bfork\s*\(/, /\bdlopen\s*\(/, /\bptrace\s*\(/,
  /\bsocket\s*\(/, /#include\s*[<"]sys\/socket/,
  /#include\s*[<"]netinet/, /#include\s*[<"]arpa\//,
  /\bunlink\s*\(/, /\bremove\s*\(/, /\brename\s*\(/, /\bchmod\s*\(/,
];

const LANGUAGE_FORBIDDEN = {
  python: PYTHON_FORBIDDEN,
  java:   JAVA_FORBIDDEN,
  c:      C_FORBIDDEN,
  cpp:    C_FORBIDDEN,
};

function validateCode(code, language) {
  if (code.length > 50000) return { safe: false, reason: 'Code too long' };
  const patterns = LANGUAGE_FORBIDDEN[language] || [];
  for (const pattern of patterns) {
    if (pattern.test(code)) return { safe: false, reason: 'Forbidden system call or import detected' };
  }
  return { safe: true };
}


function spawnProcess(cmd, args, input, timeoutMs, filesToClean = []) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '', timedOut = false;

    const child = spawn(cmd, args, { env: { ...process.env } });

    if (input) child.stdin.write(input);
    child.stdin.end();

    child.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 10000) child.kill();
    });
    child.stderr.on('data', d => { stderr += d.toString().substring(0, 1000); });

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      filesToClean.forEach(f => { try { unlinkSync(f); } catch (_) {} });
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), timedOut, exitCode: code, executionTime: Date.now() - start });
    });

    child.on('error', err => {
      clearTimeout(timer);
      filesToClean.forEach(f => { try { unlinkSync(f); } catch (_) {} });
      resolve({ stdout: '', stderr: err.message, timedOut: false, exitCode: 1, executionTime: Date.now() - start });
    });
  });
}

// ─── Python Runner ─────────────────────────────────────────────────────────────

function runPython(code, input, timeoutMs) {
  const id = uuidv4().replace(/-/g, '');
  const filePath = join(TEMP_DIR, `exam_${id}.py`);
  const wrapped = IS_WIN
    ? `import sys\n${code}\n`
    : `import resource, sys\nresource.setrlimit(resource.RLIMIT_AS, (64*1024*1024, 64*1024*1024))\nresource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))\nresource.setrlimit(resource.RLIMIT_NPROC, (1, 1))\n${code}\n`;
  try { writeFileSync(filePath, wrapped, { mode: 0o600 }); }
  catch (e) { return Promise.resolve({ stdout: '', stderr: 'Write error', timedOut: false, exitCode: 1 }); }
  return spawnProcess(IS_WIN ? 'python' : 'python3', [filePath], input, timeoutMs, [filePath]);
}

// ─── Java Runner ──────────────────────────────────────────────────────────────

async function runJava(code, input, timeoutMs) {
  const id = uuidv4().replace(/-/g, '');
  const dir = join(TEMP_DIR, `exam_java_${id}`);
  mkdirSync(dir, { recursive: true });

  const classMatch = code.match(/public\s+class\s+(\w+)/);
  const className = classMatch ? classMatch[1] : 'Main';
  const filePath = join(dir, `${className}.java`);

  try { writeFileSync(filePath, code, { mode: 0o600 }); }
  catch (e) {
    try { rmSync(dir, { recursive: true }); } catch (_) {}
    return { stdout: '', stderr: 'Write error', timedOut: false, exitCode: 1 };
  }

  const compile = await spawnProcess(JAVAC_CMD, [filePath], '', 15000, []);
  if (compile.exitCode !== 0) {
    try { rmSync(dir, { recursive: true }); } catch (_) {}
    return { stdout: '', stderr: compile.stderr || 'Compilation failed', timedOut: false, exitCode: 1 };
  }

  const result = await spawnProcess(
    JAVA_CMD, ['-Xmx64m', '-Xss4m', '-cp', dir, className],
    input, timeoutMs, []
  );

  try { rmSync(dir, { recursive: true }); } catch (_) {}
  return result;
}

// ─── C Runner ─────────────────────────────────────────────────────────────────

async function runC(code, input, timeoutMs) {
  const id = uuidv4().replace(/-/g, '');
  const srcPath = join(TEMP_DIR, `exam_${id}.c`);
  const binPath = join(TEMP_DIR, `exam_${id}${IS_WIN ? '.exe' : ''}`);

  try { writeFileSync(srcPath, code, { mode: 0o600 }); }
  catch (e) { return { stdout: '', stderr: 'Write error', timedOut: false, exitCode: 1 }; }

  const compile = await spawnProcess('gcc', [srcPath, '-o', binPath, '-O2', '-lm', '-std=c11'], '', 15000, [srcPath]);
  if (compile.exitCode !== 0) {
    try { unlinkSync(binPath); } catch (_) {}
    return { stdout: '', stderr: compile.stderr || 'Compilation failed', timedOut: false, exitCode: 1 };
  }

  return spawnProcess(binPath, [], input, timeoutMs, [binPath]);
}

// ─── C++ Runner ───────────────────────────────────────────────────────────────

async function runCpp(code, input, timeoutMs) {
  const id = uuidv4().replace(/-/g, '');
  const srcPath = join(TEMP_DIR, `exam_${id}.cpp`);
  const binPath = join(TEMP_DIR, `exam_${id}${IS_WIN ? '.exe' : ''}`);

  try { writeFileSync(srcPath, code, { mode: 0o600 }); }
  catch (e) { return { stdout: '', stderr: 'Write error', timedOut: false, exitCode: 1 }; }

  const compile = await spawnProcess('g++', [srcPath, '-o', binPath, '-O2', '-lm', '-std=c++17'], '', 15000, [srcPath]);
  if (compile.exitCode !== 0) {
    try { unlinkSync(binPath); } catch (_) {}
    return { stdout: '', stderr: compile.stderr || 'Compilation failed', timedOut: false, exitCode: 1 };
  }

  return spawnProcess(binPath, [], input, timeoutMs, [binPath]);
}

// ─── Main Executor ─────────────────────────────────────────────────────────────

const RUNNERS = { python: runPython, java: runJava, c: runC, cpp: runCpp };

async function executeCode(code, language, testCases, timeoutMs = TIMEOUT_MS) {
  const validation = validateCode(code, language);
  if (!validation.safe) return { error: `Security violation: ${validation.reason}`, results: [] };

  const runner = RUNNERS[language];
  if (!runner) return { error: `Unsupported language: ${language}`, results: [] };

  const results = [];
  for (const tc of testCases) {
    try {
      const result = await runner(code, tc.input, timeoutMs);
      const passed = !result.timedOut && result.exitCode === 0 &&
        normalizeOutput(result.stdout) === normalizeOutput(tc.expectedOutput);
      results.push({
        testCaseId: tc._id,
        passed,
        marks: passed ? tc.marks : 0,
        executionTime: result.executionTime,
        stdout: result.stdout || '',
        timedOut: result.timedOut || false,
        error: result.timedOut ? 'Time limit exceeded'
          : result.exitCode !== 0 ? result.stderr : null,
      });
    } catch (err) {
      results.push({ testCaseId: tc._id, passed: false, marks: 0, error: 'Execution error' });
    }
  }
  return { results };
}

function normalizeOutput(str) {
  return (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

module.exports = { executeCode, validateCode };
