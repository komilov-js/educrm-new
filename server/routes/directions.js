const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

const router = express.Router();
router.use(verifyToken);

// ===== Direction logo upload (multer) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'directions');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `direction-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
  if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};
const uploadLogo = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single('logo');
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

// GET /api/directions — list with aggregated stats across their branches
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (search) { conditions.push(`d.name ILIKE $${idx++}`); params.push(`%${search}%`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await query(
      `SELECT d.*,
        COUNT(DISTINCT b.id) AS branch_count,
        COUNT(DISTINCT CASE WHEN u.role = 'teacher' THEN u.id END) AS teacher_count,
        COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) AS student_count,
        COUNT(DISTINCT g.id) AS group_count
       FROM directions d
       LEFT JOIN branches b ON b.direction_id = d.id AND b.is_active = true
       LEFT JOIN users u ON u.branch_id = b.id AND u.is_active = true
       LEFT JOIN groups g ON g.branch_id = b.id AND g.is_active = true
       ${where}
       GROUP BY d.id
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/directions/:id — direction + its branches with per-branch stats
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT d.*,
        COUNT(DISTINCT b.id) AS branch_count,
        COUNT(DISTINCT CASE WHEN u.role = 'teacher' THEN u.id END) AS teacher_count,
        COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) AS student_count,
        COUNT(DISTINCT g.id) AS group_count
       FROM directions d
       LEFT JOIN branches b ON b.direction_id = d.id AND b.is_active = true
       LEFT JOIN users u ON u.branch_id = b.id AND u.is_active = true
       LEFT JOIN groups g ON g.branch_id = b.id AND g.is_active = true
       WHERE d.id = $1 GROUP BY d.id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Direction not found' });

    const { rows: branches } = await query(
      `SELECT b.id, b.name, b.address, b.logo_url, b.colors, b.is_active,
        COUNT(DISTINCT CASE WHEN u.role = 'teacher' THEN u.id END) AS teacher_count,
        COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) AS student_count,
        COUNT(DISTINCT g.id) AS group_count
       FROM branches b
       LEFT JOIN users u ON u.branch_id = b.id AND u.is_active = true
       LEFT JOIN groups g ON g.branch_id = b.id AND g.is_active = true
       WHERE b.direction_id = $1
       GROUP BY b.id ORDER BY b.created_at DESC`,
      [id]
    );

    res.json({ ...rows[0], branches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/directions
router.post('/', requireRole('super_admin'), handleLogoUpload, async (req, res) => {
  try {
    const { name, description, color } = req.body;
    if (!name) {
      if (req.file) removeUpload(`/uploads/directions/${req.file.filename}`);
      return res.status(400).json({ error: 'Direction name required' });
    }
    const logoUrl = req.file ? `/uploads/directions/${req.file.filename}` : null;
    const { rows } = await query(
      'INSERT INTO directions (name, description, color, logo_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description || null, color || 'blue', logoUrl]
    );
    await log(req.user.id, 'DIRECTION_CREATED', 'direction', rows[0].id, { name }, req.ip);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/directions/:id
router.put('/:id', requireRole('super_admin'), handleLogoUpload, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, color, is_active } = req.body;
    const updates = []; const params = []; let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); params.push(description); }
    if (color !== undefined) { updates.push(`color = $${idx++}`); params.push(color); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active === 'true' || is_active === true); }

    let oldLogo = null;
    if (req.file) {
      const cur = await query('SELECT logo_url FROM directions WHERE id = $1', [id]);
      oldLogo = cur.rows[0]?.logo_url || null;
      updates.push(`logo_url = $${idx++}`);
      params.push(`/uploads/directions/${req.file.filename}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);

    const { rows } = await query(`UPDATE directions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!rows.length) {
      if (req.file) removeUpload(`/uploads/directions/${req.file.filename}`);
      return res.status(404).json({ error: 'Direction not found' });
    }
    if (oldLogo) removeUpload(oldLogo);
    await log(req.user.id, 'DIRECTION_UPDATED', 'direction', id, null, req.ip);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/directions/:id
router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query('DELETE FROM directions WHERE id = $1 RETURNING id, name, logo_url', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Direction not found' });
    removeUpload(rows[0].logo_url);
    await log(req.user.id, 'DIRECTION_DELETED', 'direction', id, { name: rows[0].name }, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
