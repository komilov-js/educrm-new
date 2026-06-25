const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

const router = express.Router();
router.use(verifyToken);

// ===== Branch logo upload (multer) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'branches');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `branch-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};
const uploadLogo = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single('logo');

// Wrap multer so its errors return clean JSON instead of crashing
const handleLogoUpload = (req, res, next) => {
  uploadLogo(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
};

const removeUpload = (relPath) => {
  if (!relPath) return;
  const abs = path.join(process.cwd(), relPath);
  fs.existsSync(abs) && fs.unlink(abs, () => {});
};

// Colors arrive from multipart form as a JSON string or comma list
const parseColors = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const a = JSON.parse(val); if (Array.isArray(a)) return a.filter(Boolean); } catch {}
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
};
const emptyToNull = (v) => (v === undefined || v === null || v === '' ? null : v);

// GET /api/branches
router.get('/', async (req, res) => {
  try {
    const { search, is_active, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];
    let idx = 1;

    // Branch admin sees only their branch
    if (req.user.role === 'branch_admin') {
      conditions.push(`b.id = $${idx++}`);
      params.push(req.user.branch_id);
    }

    if (is_active !== undefined) { conditions.push(`b.is_active = $${idx++}`); params.push(is_active === 'true'); }
    if (search) { conditions.push(`b.name ILIKE $${idx++}`); params.push(`%${search}%`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await query(`SELECT COUNT(*) FROM branches b ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const { rows } = await query(
      `SELECT b.*, d.name as direction_name, d.color as direction_color,
        COUNT(DISTINCT CASE WHEN u.role = 'teacher' THEN u.id END) as teacher_count,
        COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) as student_count,
        COUNT(DISTINCT g.id) as group_count
       FROM branches b
       LEFT JOIN directions d ON b.direction_id = d.id
       LEFT JOIN users u ON u.branch_id = b.id AND u.is_active = true
       LEFT JOIN groups g ON g.branch_id = b.id AND g.is_active = true
       ${where}
       GROUP BY b.id, d.name, d.color ORDER BY b.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/branches/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role === 'branch_admin' && req.user.branch_id !== id) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await query(
      `SELECT b.*, d.name as direction_name, d.color as direction_color,
        COUNT(DISTINCT CASE WHEN u.role = 'teacher' THEN u.id END) as teacher_count,
        COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) as student_count,
        COUNT(DISTINCT CASE WHEN u.role = 'branch_admin' THEN u.id END) as admin_count,
        COUNT(DISTINCT g.id) as group_count
       FROM branches b
       LEFT JOIN directions d ON b.direction_id = d.id
       LEFT JOIN users u ON u.branch_id = b.id AND u.is_active = true
       LEFT JOIN groups g ON g.branch_id = b.id AND g.is_active = true
       WHERE b.id = $1 GROUP BY b.id, d.name, d.color`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });

    // Groups in this branch
    const { rows: groups } = await query(
      `SELECT g.id, g.name, g.max_students, g.is_active,
         CONCAT(t.first_name, ' ', t.last_name) as teacher_name,
         COUNT(gs.student_id) as student_count
       FROM groups g
       LEFT JOIN users t ON g.teacher_id = t.id
       LEFT JOIN group_students gs ON gs.group_id = g.id
       WHERE g.branch_id = $1
       GROUP BY g.id, t.first_name, t.last_name
       ORDER BY g.created_at DESC`,
      [id]
    );

    // Branch admins assigned to this branch
    const { rows: admins } = await query(
      `SELECT id, first_name, last_name, username, avatar_url
       FROM users WHERE branch_id = $1 AND role = 'branch_admin' AND is_active = true`,
      [id]
    );

    // Teachers in this branch — either directly assigned (users.branch_id) OR
    // teaching at least one group in the branch. group_count is groups taught here.
    const { rows: teachers } = await query(
      `SELECT u.id, u.first_name, u.last_name, u.username, u.avatar_url,
         COUNT(DISTINCT g.id) as group_count
       FROM users u
       LEFT JOIN groups g ON g.teacher_id = u.id AND g.branch_id = $1
       WHERE u.role = 'teacher' AND u.is_active = true
         AND (u.branch_id = $1 OR g.id IS NOT NULL)
       GROUP BY u.id
       ORDER BY u.first_name, u.last_name`,
      [id]
    );

    res.json({ ...rows[0], groups, admins, teachers });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/branches
router.post('/', requireRole('super_admin'), handleLogoUpload, async (req, res) => {
  try {
    const { name, address, phone, email, direction_id } = req.body;
    if (!name) {
      if (req.file) removeUpload(`/uploads/branches/${req.file.filename}`);
      return res.status(400).json({ error: 'Branch name required' });
    }

    const logoUrl = req.file ? `/uploads/branches/${req.file.filename}` : null;
    const colors = parseColors(req.body.colors);

    const { rows } = await query(
      'INSERT INTO branches (name, address, phone, email, logo_url, direction_id, colors) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, address || null, phone || null, email || null, logoUrl, emptyToNull(direction_id), colors]
    );
    await log(req.user.id, 'BRANCH_CREATED', 'branch', rows[0].id, { name }, req.ip);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/branches/:id
router.put('/:id', requireRole('super_admin'), handleLogoUpload, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, phone, email, is_active, direction_id } = req.body;

    const updates = []; const params = []; let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
    if (address !== undefined) { updates.push(`address = $${idx++}`); params.push(address); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); params.push(phone); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); params.push(email); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active === 'true' || is_active === true); }
    if (direction_id !== undefined) { updates.push(`direction_id = $${idx++}`); params.push(emptyToNull(direction_id)); }
    if (req.body.colors !== undefined) { updates.push(`colors = $${idx++}`); params.push(parseColors(req.body.colors)); }

    // New logo uploaded -> set it and remove the old file
    let oldLogo = null;
    if (req.file) {
      const cur = await query('SELECT logo_url FROM branches WHERE id = $1', [id]);
      oldLogo = cur.rows[0]?.logo_url || null;
      updates.push(`logo_url = $${idx++}`);
      params.push(`/uploads/branches/${req.file.filename}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);

    const { rows } = await query(
      `UPDATE branches SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, params
    );
    if (!rows.length) {
      if (req.file) removeUpload(`/uploads/branches/${req.file.filename}`);
      return res.status(404).json({ error: 'Branch not found' });
    }
    if (oldLogo) removeUpload(oldLogo);
    await log(req.user.id, 'BRANCH_UPDATED', 'branch', id, null, req.ip);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/branches/:id
router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query('DELETE FROM branches WHERE id = $1 RETURNING id, name, logo_url', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Branch not found' });
    removeUpload(rows[0].logo_url);
    await log(req.user.id, 'BRANCH_DELETED', 'branch', id, { name: rows[0].name }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
