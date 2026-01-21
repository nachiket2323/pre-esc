const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Trust proxy for correct IP
app.set('trust proxy', true);

// Sanitize username/IP - remove dangerous characters
function sanitizeName(name) {
    if (!name) return null;
    return name
        .replace(/\.\./g, '')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 50);
}

// Get client identifier (username or IP)
function getClientId(req) {
    const username = req.body?.username;
    if (username && username.trim()) {
        return sanitizeName(username.trim());
    }
    // Fallback to IP
    let ip = req.ip || req.connection.remoteAddress || 'unknown';
    ip = ip.replace(/^::ffff:/, ''); // Remove IPv6 prefix
    return sanitizeName(ip);
}

// Format file size
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format date
function formatDate(date) {
    return new Date(date).toISOString().replace('T', ' ').substring(0, 19);
}

// Multer storage - upload to temp, then move to user folder
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Upload to temp folder first - we'll move it after form is parsed
        const tempDir = path.join(UPLOAD_DIR, '.temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        // Add timestamp to prevent overwrites
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${timestamp}_${safeName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Move file from temp to user folder after upload
function moveToUserFolder(req) {
    if (!req.file) return null;

    const clientId = getClientId(req);
    const userDir = path.join(UPLOAD_DIR, clientId);

    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    const oldPath = req.file.path;
    const newPath = path.join(userDir, req.file.filename);

    fs.renameSync(oldPath, newPath);
    req.file.path = newPath;
    req.file.destination = userDir;

    return clientId;
}

// ============ ROUTES ============

// Root - List all user folders
app.get('/', (req, res) => {
    try {
        const items = [];
        if (fs.existsSync(UPLOAD_DIR)) {
            const folders = fs.readdirSync(UPLOAD_DIR);
            for (const folder of folders) {
                if (folder === '.temp') continue; // Skip temp folder
                const folderPath = path.join(UPLOAD_DIR, folder);
                const stat = fs.statSync(folderPath);
                if (stat.isDirectory()) {
                    const fileCount = fs.readdirSync(folderPath).length;
                    items.push({
                        name: folder,
                        isDir: true,
                        size: `${fileCount} file(s)`,
                        modified: formatDate(stat.mtime)
                    });
                }
            }
        }

        // Check if curl request
        const isCurl = req.headers['user-agent']?.includes('curl');
        if (isCurl) {
            let output = 'Directory: /uploads\n';
            output += '='.repeat(60) + '\n';
            output += 'Name'.padEnd(30) + 'Files'.padEnd(15) + 'Modified\n';
            output += '-'.repeat(60) + '\n';
            for (const item of items) {
                output += `[DIR] ${item.name}`.padEnd(30) + item.size.padEnd(15) + item.modified + '\n';
            }
            output += '-'.repeat(60) + '\n';
            output += `Total: ${items.length} folder(s)\n`;
            output += `\nUpload: curl -F "file=@yourfile.txt" -F "username=yourname" ${BASE_URL}/upload\n`;
            res.type('text/plain').send(output);
        } else {
            res.render('index', { items, formatSize, formatDate });
        }
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
});

// User directory - List files for a user
app.get('/uploads/:user', (req, res) => {
    const user = sanitizeName(req.params.user);
    const userDir = path.join(UPLOAD_DIR, user);

    if (!userDir.startsWith(UPLOAD_DIR)) {
        return res.status(403).send('Access denied.\n');
    }

    if (!fs.existsSync(userDir)) {
        const isCurl = req.headers['user-agent']?.includes('curl');
        if (isCurl) {
            return res.status(404).send(`Error: User folder "${user}" not found.\n`);
        }
        return res.status(404).render('error', { message: `User folder "${user}" not found` });
    }

    try {
        const files = fs.readdirSync(userDir).map(filename => {
            const filepath = path.join(userDir, filename);
            const stat = fs.statSync(filepath);
            return {
                name: filename,
                isDir: false,
                size: formatSize(stat.size),
                sizeBytes: stat.size,
                modified: formatDate(stat.mtime)
            };
        });

        const isCurl = req.headers['user-agent']?.includes('curl');
        if (isCurl) {
            let output = `Directory: /uploads/${user}\n`;
            output += '='.repeat(80) + '\n';
            output += 'Filename'.padEnd(45) + 'Size'.padEnd(15) + 'Modified\n';
            output += '-'.repeat(80) + '\n';
            for (const file of files) {
                output += file.name.substring(0, 44).padEnd(45) + file.size.padEnd(15) + file.modified + '\n';
            }
            output += '-'.repeat(80) + '\n';
            output += `Total: ${files.length} file(s)\n`;
            output += `\nDownload: curl -O ${BASE_URL}/download/<filename>\n`;
            res.type('text/plain').send(output);
        } else {
            res.render('directory', { user, files });
        }
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
});

// Upload page (GET)
app.get('/upload', (req, res) => {
    const isCurl = req.headers['user-agent']?.includes('curl');
    if (isCurl) {
        res.type('text/plain').send(`
File Upload - curl Command
===========================

Upload with username:
  curl -F "file=@yourfile.txt" -F "username=yourname" ${BASE_URL}/upload

Upload with IP (auto):
  curl -F "file=@yourfile.txt" ${BASE_URL}/upload

`);
    } else {
        res.render('upload');
    }
});

// Upload handler (POST)
app.post('/upload', upload.single('file'), (req, res) => {
    const isCurl = req.headers['user-agent']?.includes('curl');

    if (!req.file) {
        if (isCurl) {
            return res.status(400).send('Error: No file uploaded. Use -F "file=@yourfile.txt"\n');
        }
        return res.status(400).render('error', { message: 'No file uploaded' });
    }

    // Now form fields are parsed, move file to correct user folder
    const clientId = moveToUserFolder(req);
    const msg = `Success: "${req.file.originalname}" uploaded to /${clientId}/ (${formatSize(req.file.size)})\n`;

    if (isCurl) {
        res.type('text/plain').send(msg);
    } else {
        res.render('upload', { success: msg, clientId });
    }
});

// Download file - searches all user folders
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const isCurl = req.headers['user-agent']?.includes('curl');

    // Search for file in all user directories
    try {
        const users = fs.readdirSync(UPLOAD_DIR);
        for (const user of users) {
            const userDir = path.join(UPLOAD_DIR, user);
            if (!fs.statSync(userDir).isDirectory()) continue;

            const filepath = path.join(userDir, filename);
            if (fs.existsSync(filepath)) {
                // Security check
                if (!filepath.startsWith(UPLOAD_DIR)) {
                    return res.status(403).send('Access denied.\n');
                }

                return res.download(filepath, filename, (err) => {
                    if (err && !res.headersSent) {
                        if (isCurl) {
                            res.status(500).send(`Error: ${err.message}\n`);
                        } else {
                            res.status(500).render('error', { message: err.message });
                        }
                    }
                });
            }
        }

        // File not found
        if (isCurl) {
            res.status(404).send(`Error: File "${filename}" not found.\n`);
        } else {
            res.status(404).render('error', { message: `File "${filename}" not found` });
        }
    } catch (err) {
        if (isCurl) {
            res.status(500).send(`Error: ${err.message}\n`);
        } else {
            res.status(500).render('error', { message: err.message });
        }
    }
});

// List all files (flat view for admin)
app.get('/files', (req, res) => {
    const isCurl = req.headers['user-agent']?.includes('curl');

    try {
        const allFiles = [];
        const users = fs.readdirSync(UPLOAD_DIR);

        for (const user of users) {
            const userDir = path.join(UPLOAD_DIR, user);
            if (!fs.statSync(userDir).isDirectory()) continue;

            const files = fs.readdirSync(userDir);
            for (const file of files) {
                const filepath = path.join(userDir, file);
                const stat = fs.statSync(filepath);
                allFiles.push({
                    user,
                    name: file,
                    size: formatSize(stat.size),
                    modified: formatDate(stat.mtime)
                });
            }
        }

        if (isCurl) {
            let output = 'All Files\n';
            output += '='.repeat(100) + '\n';
            output += 'User'.padEnd(20) + 'Filename'.padEnd(50) + 'Size'.padEnd(15) + 'Modified\n';
            output += '-'.repeat(100) + '\n';
            for (const f of allFiles) {
                output += f.user.padEnd(20) + f.name.substring(0, 49).padEnd(50) + f.size.padEnd(15) + f.modified + '\n';
            }
            output += '-'.repeat(100) + '\n';
            output += `Total: ${allFiles.length} file(s)\n`;
            res.type('text/plain').send(output);
        } else {
            res.render('index', { items: allFiles, showAll: true });
        }
    } catch (err) {
        res.status(500).send(`Error: ${err.message}\n`);
    }
});

// Help
app.get('/help', (req, res) => {
    res.type('text/plain').send(`
File Repository - curl Commands
================================

LIST folders:
  curl ${BASE_URL}/

LIST user files:
  curl ${BASE_URL}/uploads/<username>

LIST all files:
  curl ${BASE_URL}/files

UPLOAD file:
  curl -F "file=@yourfile.txt" -F "username=yourname" ${BASE_URL}/upload

DOWNLOAD file:
  curl -O ${BASE_URL}/download/<filename>

HELP:
  curl ${BASE_URL}/help

`);
});

// 404 handler
app.use((req, res) => {
    const isCurl = req.headers['user-agent']?.includes('curl');
    if (isCurl) {
        res.status(404).send('Error: Page not found.\n');
    } else {
        res.status(404).render('error', { message: 'Page not found' });
    }
});

// Error handler
app.use((err, req, res, next) => {
    const isCurl = req.headers['user-agent']?.includes('curl');
    if (err.code === 'LIMIT_FILE_SIZE') {
        if (isCurl) {
            return res.status(413).send('Error: File too large. Max size is 50MB.\n');
        }
        return res.status(413).render('error', { message: 'File too large. Max size is 50MB.' });
    }
    if (isCurl) {
        res.status(500).send(`Error: ${err.message}\n`);
    } else {
        res.status(500).render('error', { message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`File Repository running on http://localhost:${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`\ncurl commands:`);
    console.log(`  List:     curl http://localhost:${PORT}/`);
    console.log(`  Upload:   curl -F "file=@file.txt" -F "username=name" http://localhost:${PORT}/upload`);
    console.log(`  Download: curl -O http://localhost:${PORT}/download/<filename>`);
    console.log(`  Help:     curl http://localhost:${PORT}/help`);
});
