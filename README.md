# File Repository

A Node.js file repository with upload/download support, organized by username or IP address.

## Quick Start

```bash
npm install
npm start
```

Server runs on http://localhost:3000

## curl Commands

### List folders
```bash
curl http://localhost:3000/
```

### List user files
```bash
curl http://localhost:3000/uploads/nachiket
```

### List all files
```bash
curl http://localhost:3000/files
```

### Upload file (with username)
```bash
curl -F "file=@test.txt" -F "username=nachiket" http://localhost:3000/upload
```

### Upload file (IP fallback)
```bash
curl -F "file=@test.txt" http://localhost:3000/upload
```

### Download file
```bash
curl -O http://localhost:3000/download/filename.txt
```

### Help
```bash
curl http://localhost:3000/help
```

## Folder Structure

```
uploads/
├── nachiket/
│   └── 1705123456_file.txt
├── 192.168.1.10/
│   └── 1705123789_data.zip
```

## Security

- Max file size: 50MB
- Path traversal protection
- Filename sanitization
- Timestamp prefix prevents overwrites

## Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | / | List user folders |
| GET | /uploads/:user | List files for user |
| GET | /upload | Upload form |
| POST | /upload | Handle file upload |
| GET | /download/:filename | Download file |
| GET | /files | List all files |
| GET | /help | curl help |
