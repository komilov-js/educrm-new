const express = require('express');
const ExcelJS = require('exceljs');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

const router = express.Router();
router.use(verifyToken);

// Build the list of lesson dates in a month for the given weekdays (0=Sun..6=Sat)
function lessonDatesInMonth(year, month /* 1-12 */, days) {
  const dates = [];
  const last = new Date(year, month, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (days.includes(dow)) {
      dates.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return dates;
}

// Verify the current user may manage attendance for a group
async function assertGroupAccess(req, groupId) {
  const { rows } = await query('SELECT id, branch_id, teacher_id FROM groups WHERE id = $1', [groupId]);
  if (!rows.length) return { ok: false, code: 404, error: 'Group not found' };
  const g = rows[0];
  if (req.user.role === 'teacher' && g.teacher_id !== req.user.id) return { ok: false, code: 403, error: 'Not assigned to this group' };
  if (req.user.role === 'branch_admin' && g.branch_id !== req.user.branch_id) return { ok: false, code: 403, error: 'Access denied' };
  if (req.user.role === 'student') return { ok: false, code: 403, error: 'Access denied' };
  return { ok: true, group: g };
}

// GET /api/attendance/sessions
router.get('/sessions', async (req, res) => {
  try {
    const { group_id, from_date, to_date, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.user.role === 'teacher') {
      conditions.push(`s.teacher_id = $${idx++}`); params.push(req.user.id);
    } else if (req.user.role === 'branch_admin') {
      conditions.push(`g.branch_id = $${idx++}`); params.push(req.user.branch_id);
    }

    if (group_id) { conditions.push(`s.group_id = $${idx++}`); params.push(group_id); }
    if (from_date) { conditions.push(`s.session_date >= $${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`s.session_date <= $${idx++}`); params.push(to_date); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRes = await query(
      `SELECT COUNT(*) FROM attendance_sessions s JOIN groups g ON s.group_id = g.id ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count);

    const { rows } = await query(
      `SELECT s.*, g.name as group_name, b.name as branch_name,
         CONCAT(t.first_name, ' ', t.last_name) as teacher_name,
         COUNT(ar.id) as total_records,
         SUM(CASE WHEN ar.status = 'present' THEN 1 ELSE 0 END) as present_count,
         SUM(CASE WHEN ar.status = 'absent' THEN 1 ELSE 0 END) as absent_count,
         SUM(CASE WHEN ar.status = 'late' THEN 1 ELSE 0 END) as late_count
       FROM attendance_sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN branches b ON g.branch_id = b.id
       LEFT JOIN users t ON s.teacher_id = t.id
       LEFT JOIN attendance_records ar ON ar.session_id = s.id
       ${where}
       GROUP BY s.id, g.name, b.name, t.first_name, t.last_name
       ORDER BY s.session_date DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/sessions/:id
router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: sessions } = await query(
      `SELECT s.*, g.name as group_name, CONCAT(t.first_name, ' ', t.last_name) as teacher_name
       FROM attendance_sessions s
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN users t ON s.teacher_id = t.id
       WHERE s.id = $1`,
      [id]
    );
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });

    const { rows: records } = await query(
      `SELECT ar.*, CONCAT(u.first_name, ' ', u.last_name) as student_name, u.username, u.avatar_url
       FROM attendance_records ar
       JOIN users u ON ar.student_id = u.id
       WHERE ar.session_id = $1 ORDER BY u.first_name`,
      [id]
    );

    res.json({ ...sessions[0], records });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attendance/sessions — create or update a session with all records
router.post('/sessions', requireRole('super_admin', 'branch_admin', 'teacher'), async (req, res) => {
  try {
    const { group_id, session_date, start_time, notes, records } = req.body;
    if (!group_id || !session_date || !start_time) {
      return res.status(400).json({ error: 'group_id, session_date, and start_time required' });
    }

    // Validate teacher access
    if (req.user.role === 'teacher') {
      const { rows } = await query('SELECT id FROM groups WHERE id = $1 AND teacher_id = $2', [group_id, req.user.id]);
      if (!rows.length) return res.status(403).json({ error: 'Not assigned to this group' });
    }

    const client = await require('../db').getClient();
    try {
      await client.query('BEGIN');

      // Upsert session
      const { rows: sessions } = await client.query(
        `INSERT INTO attendance_sessions (group_id, teacher_id, session_date, start_time, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (group_id, session_date)
         DO UPDATE SET start_time = EXCLUDED.start_time, notes = EXCLUDED.notes, teacher_id = EXCLUDED.teacher_id
         RETURNING *`,
        [group_id, req.user.id, session_date, start_time, notes || null]
      );
      const session = sessions[0];

      // Upsert attendance records
      if (records && Array.isArray(records)) {
        for (const rec of records) {
          const { student_id, status, arrival_time, late_minutes } = rec;
          if (!student_id || !status) continue;

          const lateMin = status === 'late' ? (late_minutes || 0) : 0;
          await client.query(
            `INSERT INTO attendance_records (session_id, student_id, status, arrival_time, late_minutes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id, student_id)
             DO UPDATE SET status = EXCLUDED.status, arrival_time = EXCLUDED.arrival_time, late_minutes = EXCLUDED.late_minutes`,
            [session.id, student_id, status, arrival_time || null, lateMin]
          );
        }
      }

      await client.query('COMMIT');
      await log(req.user.id, 'ATTENDANCE_SAVED', 'attendance_session', session.id, { group_id, session_date }, req.ip);
      res.status(201).json(session);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/grid?group_id=&month=YYYY-MM — register grid for a month
router.get('/grid', async (req, res) => {
  try {
    const { group_id, month } = req.query;
    if (!group_id) return res.status(400).json({ error: 'group_id required' });

    const access = await assertGroupAccess(req, group_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const now = new Date();
    const [y, m] = (month && /^\d{4}-\d{2}$/.test(month))
      ? month.split('-').map(Number)
      : [now.getFullYear(), now.getMonth() + 1];

    // Students enrolled in the group
    const { rows: students } = await query(
      `SELECT u.id, u.first_name, u.last_name, u.username, u.avatar_url
       FROM group_students gs JOIN users u ON gs.student_id = u.id
       WHERE gs.group_id = $1 AND u.is_active = true
       ORDER BY u.first_name, u.last_name`,
      [group_id]
    );

    // Schedule weekdays + start times
    const { rows: schedules } = await query(
      'SELECT day_of_week, start_time FROM schedules WHERE group_id = $1 ORDER BY day_of_week',
      [group_id]
    );
    const days = [...new Set(schedules.map(s => s.day_of_week))];
    const startByDay = {};
    schedules.forEach(s => { if (!startByDay[s.day_of_week]) startByDay[s.day_of_week] = s.start_time; });

    const scheduledDates = days.length ? lessonDatesInMonth(y, m, days) : [];

    // Existing records for the month
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;
    const { rows: recs } = await query(
      `SELECT TO_CHAR(s.session_date, 'YYYY-MM-DD') AS session_date, ar.student_id, ar.status, ar.late_minutes
       FROM attendance_sessions s
       JOIN attendance_records ar ON ar.session_id = s.id
       WHERE s.group_id = $1 AND s.session_date BETWEEN $2 AND $3`,
      [group_id, first, last]
    );

    const records = {};
    for (const r of recs) {
      const dateKey = String(r.session_date).slice(0, 10);
      records[dateKey] = records[dateKey] || {};
      records[dateKey][r.student_id] = { status: r.status, late_minutes: r.late_minutes };
    }

    // Columns = scheduled lesson days ∪ any day that already has records, so marked
    // attendance is always shown in the register — even on non-scheduled dates or
    // when the group has no schedule at all.
    const dates = [...new Set([...scheduledDates, ...Object.keys(records)])].sort();

    res.json({ year: y, month: m, students, dates, records, startByDay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attendance/mark — set one student's status for one date
router.post('/mark', requireRole('super_admin', 'branch_admin', 'teacher'), async (req, res) => {
  try {
    const { group_id, session_date, student_id, status, late_minutes, start_time } = req.body;
    if (!group_id || !session_date || !student_id || !status) {
      return res.status(400).json({ error: 'group_id, session_date, student_id and status required' });
    }
    if (!['present', 'absent', 'late'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const access = await assertGroupAccess(req, group_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const { rows: sessions } = await query(
      `INSERT INTO attendance_sessions (group_id, teacher_id, session_date, start_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, session_date)
       DO UPDATE SET teacher_id = COALESCE(attendance_sessions.teacher_id, EXCLUDED.teacher_id)
       RETURNING id`,
      [group_id, req.user.id, session_date, start_time || '00:00']
    );
    const sessionId = sessions[0].id;
    const lateMin = status === 'late' ? (late_minutes || 0) : 0;

    await query(
      `INSERT INTO attendance_records (session_id, student_id, status, late_minutes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, student_id)
       DO UPDATE SET status = EXCLUDED.status, late_minutes = EXCLUDED.late_minutes`,
      [sessionId, student_id, status, lateMin]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/export?group_id=&date=YYYY-MM-DD — Excel of that date's attendance
router.get('/export', async (req, res) => {
  try {
    const { group_id, date } = req.query;
    if (!group_id || !date) return res.status(400).json({ error: 'group_id and date required' });

    const access = await assertGroupAccess(req, group_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const { rows: ginfo } = await query(
      `SELECT g.name as group_name, b.name as branch_name FROM groups g
       LEFT JOIN branches b ON g.branch_id = b.id WHERE g.id = $1`,
      [group_id]
    );
    const groupName = ginfo[0]?.group_name || 'Group';

    // All enrolled students with that date's status (left join so absent-of-record show blank)
    const { rows } = await query(
      `SELECT u.first_name, u.last_name, u.username, u.phone, u.email,
              ar.status, ar.arrival_time, ar.late_minutes
       FROM group_students gs
       JOIN users u ON gs.student_id = u.id
       LEFT JOIN attendance_sessions s ON s.group_id = gs.group_id AND s.session_date = $2
       LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.student_id = u.id
       WHERE gs.group_id = $1 AND u.is_active = true
       ORDER BY u.first_name, u.last_name`,
      [group_id, date]
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');
    ws.mergeCells('A1', 'G1');
    ws.getCell('A1').value = `${groupName} — ${date}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.addRow([]);

    const header = ws.addRow(['#', 'Student', 'Username', 'Phone', 'Status', 'Arrival', 'Late (min)']);
    header.font = { bold: true };
    header.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });

    const statusLabel = { present: 'Present', absent: 'Absent', late: 'Late' };
    rows.forEach((r, i) => {
      ws.addRow([
        i + 1,
        `${r.first_name} ${r.last_name}`,
        r.username,
        r.phone || '',
        r.status ? statusLabel[r.status] : '—',
        r.arrival_time || '',
        r.status === 'late' ? (r.late_minutes || 0) : '',
      ]);
    });

    ws.columns = [
      { width: 5 }, { width: 28 }, { width: 18 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 12 },
    ];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/attendance/student/:studentId — student attendance history
router.get('/student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { from_date, to_date, group_id } = req.query;

    if (req.user.role === 'student' && req.user.id !== studentId) return res.status(403).json({ error: 'Access denied' });

    const conditions = [`ar.student_id = $1`];
    const params = [studentId];
    let idx = 2;

    if (from_date) { conditions.push(`s.session_date >= $${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`s.session_date <= $${idx++}`); params.push(to_date); }
    if (group_id) { conditions.push(`s.group_id = $${idx++}`); params.push(group_id); }

    const where = 'WHERE ' + conditions.join(' AND ');
    const { rows } = await query(
      `SELECT ar.*, s.session_date, s.start_time, g.name as group_name,
         CONCAT(t.first_name, ' ', t.last_name) as teacher_name
       FROM attendance_records ar
       JOIN attendance_sessions s ON ar.session_id = s.id
       JOIN groups g ON s.group_id = g.id
       LEFT JOIN users t ON s.teacher_id = t.id
       ${where}
       ORDER BY s.session_date DESC`,
      params
    );

    // Stats
    const total = rows.length;
    const present = rows.filter(r => r.status === 'present').length;
    const absent = rows.filter(r => r.status === 'absent').length;
    const late = rows.filter(r => r.status === 'late').length;
    const avgLate = late > 0 ? Math.round(rows.filter(r => r.status === 'late').reduce((s, r) => s + (r.late_minutes || 0), 0) / late) : 0;
    const attendancePct = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

    res.json({ records: rows, stats: { total, present, absent, late, avgLate, attendancePct } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/stats — overall stats
router.get('/stats', async (req, res) => {
  try {
    const { branch_id, group_id, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.user.role === 'branch_admin') {
      conditions.push(`g.branch_id = $${idx++}`); params.push(req.user.branch_id);
    } else if (branch_id) {
      conditions.push(`g.branch_id = $${idx++}`); params.push(branch_id);
    }
    if (group_id) { conditions.push(`s.group_id = $${idx++}`); params.push(group_id); }
    if (from_date) { conditions.push(`s.session_date >= $${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`s.session_date <= $${idx++}`); params.push(to_date); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await query(
      `SELECT
         COUNT(ar.id) as total,
         SUM(CASE WHEN ar.status = 'present' THEN 1 ELSE 0 END) as present_count,
         SUM(CASE WHEN ar.status = 'absent' THEN 1 ELSE 0 END) as absent_count,
         SUM(CASE WHEN ar.status = 'late' THEN 1 ELSE 0 END) as late_count,
         ROUND(AVG(CASE WHEN ar.status = 'late' THEN ar.late_minutes END)) as avg_late_minutes
       FROM attendance_records ar
       JOIN attendance_sessions s ON ar.session_id = s.id
       JOIN groups g ON s.group_id = g.id
       ${where}`,
      params
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
