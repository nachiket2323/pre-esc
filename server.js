const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_DIR = path.join(__dirname, 'uploads', 'admin');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Admin credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD
    ? bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)
    : bcrypt.hashSync('admin123', 10); // Default password for development

// Ensure uploads and admin directories exist
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(ADMIN_DIR)) {
    fs.mkdirSync(ADMIN_DIR, { recursive: true });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Trust proxy for correct IP
app.set('trust proxy', true);

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    const isCurl = req.headers['user-agent']?.includes('curl');
    if (isCurl) {
        return res.status(401).send('Error: Authentication required. Use web interface to login.\\n');
    }
    res.redirect('/admin/login');
}

// Make isAdmin available to all views
app.use((req, res, next) => {
    res.locals.isAdmin = req.session && req.session.isAdmin;
    next();
});

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
        // Use sanitized original name
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safeName);
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

// Delete file - searches all user folders (curl DELETE) - PROTECTED
app.delete('/delete/:filename', requireAuth, (req, res) => {
    const filename = req.params.filename;

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

                fs.unlinkSync(filepath);
                return res.send(`Success: File "${filename}" deleted.\n`);
            }
        }
        res.status(404).send(`Error: File "${filename}" not found.\n`);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}\n`);
    }
});

// Delete file - web handler (POST) - PROTECTED
app.post('/delete', requireAuth, upload.none(), (req, res) => {
    const filename = req.body.filename;
    const user = req.body.user; // To redirect back to correct folder

    if (!filename) {
        return res.status(400).render('error', { message: 'Filename required' });
    }

    try {
        const users = fs.readdirSync(UPLOAD_DIR);
        let deleted = false;

        for (const u of users) {
            const userDir = path.join(UPLOAD_DIR, u);
            if (!fs.statSync(userDir).isDirectory()) continue;

            const filepath = path.join(userDir, filename);
            if (fs.existsSync(filepath)) {
                // Security check
                if (!filepath.startsWith(UPLOAD_DIR)) {
                    return res.status(403).render('error', { message: 'Access denied' });
                }

                fs.unlinkSync(filepath);
                deleted = true;
                break;
            }
        }

        if (deleted) {
            // Redirect back to user folder if provided, else home
            if (user) {
                res.redirect(`/uploads/${user}`);
            } else {
                res.redirect('/');
            }
        } else {
            res.status(404).render('error', { message: `File "${filename}" not found` });
        }
    } catch (err) {
        res.status(500).render('error', { message: err.message });
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

DELETE file:
  curl -X DELETE ${BASE_URL}/delete/<filename>

HELP:
  curl ${BASE_URL}/help

`);
});

// ============ ADMIN ROUTES ============

// Multer storage for admin uploads
const adminStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, ADMIN_DIR);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safeName);
    }
});

const adminUpload = multer({
    storage: adminStorage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Admin login page (GET)
app.get('/admin/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.render('login', { error: null });
});

// Admin login handler (POST)
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.render('login', { error: 'Invalid username or password' });
    }
});

// Admin logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/admin');
    });
});

// Admin directory listing (PUBLIC - anyone can view/download)
app.get('/admin', (req, res) => {
    try {
        const files = [];
        if (fs.existsSync(ADMIN_DIR)) {
            const entries = fs.readdirSync(ADMIN_DIR);
            for (const filename of entries) {
                const filepath = path.join(ADMIN_DIR, filename);
                const stat = fs.statSync(filepath);
                if (stat.isFile()) {
                    files.push({
                        name: filename,
                        size: formatSize(stat.size),
                        sizeBytes: stat.size,
                        modified: formatDate(stat.mtime)
                    });
                }
            }
        }

        const isCurl = req.headers['user-agent']?.includes('curl');
        if (isCurl) {
            let output = 'Admin Directory\\n';
            output += '='.repeat(80) + '\\n';
            output += 'Filename'.padEnd(45) + 'Size'.padEnd(15) + 'Modified\\n';
            output += '-'.repeat(80) + '\\n';
            for (const file of files) {
                output += file.name.substring(0, 44).padEnd(45) + file.size.padEnd(15) + file.modified + '\\n';
            }
            output += '-'.repeat(80) + '\\n';
            output += `Total: ${files.length} file(s)\\n`;
            output += `\\nDownload: curl -O ${BASE_URL}/admin/download/<filename>\\n`;
            res.type('text/plain').send(output);
        } else {
            res.render('admin-directory', { files });
        }
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
});

// Admin upload page (GET) - PROTECTED
app.get('/admin/upload', requireAuth, (req, res) => {
    const isCurl = req.headers['user-agent']?.includes('curl');
    if (isCurl) {
        res.type('text/plain').send('Error: Use web interface to upload admin files.\\n');
    } else {
        res.render('admin-upload', { success: null });
    }
});

// Admin upload handler (POST) - PROTECTED
app.post('/admin/upload', requireAuth, adminUpload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).render('error', { message: 'No file uploaded' });
    }

    const msg = `"${req.file.originalname}" uploaded to admin folder (${formatSize(req.file.size)})`;
    res.render('admin-upload', { success: msg });
});

// Admin download (PUBLIC - anyone can download)
app.get('/admin/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(ADMIN_DIR, filename);
    const isCurl = req.headers['user-agent']?.includes('curl');

    // Security check
    if (!filepath.startsWith(ADMIN_DIR)) {
        return res.status(403).send('Access denied.\\n');
    }

    if (!fs.existsSync(filepath)) {
        if (isCurl) {
            return res.status(404).send(`Error: File "${filename}" not found.\\n`);
        }
        return res.status(404).render('error', { message: `File "${filename}" not found` });
    }

    res.download(filepath, filename, (err) => {
        if (err && !res.headersSent) {
            if (isCurl) {
                res.status(500).send(`Error: ${err.message}\\n`);
            } else {
                res.status(500).render('error', { message: err.message });
            }
        }
    });
});

// Admin delete folder (POST) - PROTECTED
app.post('/admin/delete-folder', requireAuth, (req, res) => {
    const folderName = req.body.folderName;

    if (!folderName) {
        return res.status(400).render('error', { message: 'Folder name required' });
    }

    // Prevent deleting admin folder or special system folders
    if (folderName === 'admin' || folderName === '.temp') {
        return res.status(403).render('error', { message: 'Cannot delete system folders' });
    }

    const folderPath = path.join(UPLOAD_DIR, folderName);

    // Security check
    if (!folderPath.startsWith(UPLOAD_DIR)) {
        return res.status(403).render('error', { message: 'Access denied' });
    }

    if (fs.existsSync(folderPath)) {
        try {
            fs.rmSync(folderPath, { recursive: true, force: true });
            res.redirect('/');
        } catch (err) {
            res.status(500).render('error', { message: `Failed to delete folder: ${err.message}` });
        }
    } else {
        res.status(404).render('error', { message: 'Folder not found' });
    }
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
