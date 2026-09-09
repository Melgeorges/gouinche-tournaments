'use strict';

const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gouinche.db');

// ── Base de données ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');  // écritures concurrentes
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    location    TEXT NOT NULL,
    max_pairs   INTEGER NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player1           TEXT NOT NULL,
    player2           TEXT,
    status            TEXT NOT NULL CHECK(status IN ('confirmed','waitlist')),
    waitlist_position INTEGER,
    registered_at     TEXT DEFAULT (datetime('now'))
  );
`);

// ── Requêtes préparées ───────────────────────────────────────────────────────
const stmts = {
  listSessions: db.prepare(`
    SELECT s.*,
      COALESCE(SUM(CASE WHEN r.status='confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_count,
      COALESCE(SUM(CASE WHEN r.status='waitlist'  THEN 1 ELSE 0 END), 0) AS waitlist_count
    FROM sessions s LEFT JOIN registrations r ON r.session_id = s.id
    GROUP BY s.id ORDER BY s.date ASC, s.time ASC
  `),
  getSession: db.prepare(`
    SELECT s.*,
      COALESCE(SUM(CASE WHEN r.status='confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_count,
      COALESCE(SUM(CASE WHEN r.status='waitlist'  THEN 1 ELSE 0 END), 0) AS waitlist_count
    FROM sessions s LEFT JOIN registrations r ON r.session_id = s.id
    WHERE s.id = ? GROUP BY s.id
  `),
  getRegistrations: db.prepare(`
    SELECT * FROM registrations WHERE session_id = ?
    ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END ASC, registered_at ASC
  `),
  checkDup: db.prepare(`
    SELECT id FROM registrations WHERE session_id = ?
    AND (lower(player1) = lower(?) OR (player2 IS NOT NULL AND lower(player2) = lower(?)))
  `),
  countConfirmed: db.prepare(
    `SELECT COUNT(*) AS count FROM registrations WHERE session_id = ? AND status = 'confirmed'`
  ),
  maxWaitlistPos: db.prepare(
    `SELECT COALESCE(MAX(waitlist_position), 0) AS max FROM registrations WHERE session_id = ? AND status = 'waitlist'`
  ),
  firstWaitlisted: db.prepare(
    `SELECT id FROM registrations WHERE session_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC LIMIT 1`
  ),
};

// ── Serveur ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const adminAuth = (req, res, next) => {
  if (!ADMIN_PASSWORD || req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
};

// ── Routes API ───────────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  res.json(stmts.listSessions.all());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session non trouvée' });
  res.json({ ...session, registrations: stmts.getRegistrations.all(req.params.id) });
});

app.post('/api/sessions', adminAuth, (req, res) => {
  const { date, time, location, max_pairs } = req.body;
  if (!date || !time || !location || !max_pairs) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return res.status(400).json({ error: 'Impossible de créer une session dans le passé' });
  }
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, date, time, location, max_pairs) VALUES (?, ?, ?, ?, ?)')
    .run(id, date, time, location, Number(max_pairs));
  res.status(201).json({ id });
});

app.patch('/api/sessions/:id', adminAuth, (req, res) => {
  // Mise à jour simple des champs date / time / location
  const { date, time, location } = req.body;
  if (date || time || location) {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session non trouvée' });
    if (date)            db.prepare('UPDATE sessions SET date     = ? WHERE id = ?').run(date, req.params.id);
    if (time)            db.prepare('UPDATE sessions SET time     = ? WHERE id = ?').run(time, req.params.id);
    if (location?.trim()) db.prepare('UPDATE sessions SET location = ? WHERE id = ?').run(location.trim(), req.params.id);
    if (req.body.max_pairs === undefined) return res.json({ ok: true });
  }

  // Mise à jour du nombre de binômes (avec gestion liste d'attente)
  const newMax = parseInt(req.body.max_pairs);
  if (!newMax || newMax < 1) return res.status(400).json({ error: 'Nombre invalide' });

  const result = db.transaction(() => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return { error: 'Session non trouvée', code: 404 };

    db.prepare('UPDATE sessions SET max_pairs = ? WHERE id = ?').run(newMax, req.params.id);

    const confirmed = db.prepare(
      `SELECT * FROM registrations WHERE session_id = ? AND status = 'confirmed' ORDER BY registered_at ASC`
    ).all(req.params.id);

    if (newMax > session.max_pairs) {
      // Promouvoir depuis la liste d'attente pour remplir les nouvelles places
      const newSpots = newMax - confirmed.length;
      if (newSpots > 0) {
        const toPromote = db.prepare(
          `SELECT * FROM registrations WHERE session_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC LIMIT ?`
        ).all(req.params.id, newSpots);
        for (const r of toPromote) {
          db.prepare(`UPDATE registrations SET status = 'confirmed', waitlist_position = NULL WHERE id = ?`).run(r.id);
        }
        // Renuméroter la liste d'attente restante
        const remaining = db.prepare(
          `SELECT id FROM registrations WHERE session_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC`
        ).all(req.params.id);
        remaining.forEach((r, i) => db.prepare(`UPDATE registrations SET waitlist_position = ? WHERE id = ?`).run(i + 1, r.id));
      }
    } else if (newMax < session.max_pairs && confirmed.length > newMax) {
      // Rétrograder les derniers inscrits confirmés en liste d'attente
      const toDemote = confirmed.slice(newMax); // confirmés triés par date d'inscription, on garde les premiers
      const { max: currentMaxPos } = db.prepare(
        `SELECT COALESCE(MAX(waitlist_position), 0) AS max FROM registrations WHERE session_id = ? AND status = 'waitlist'`
      ).get(req.params.id);
      toDemote.forEach((r, i) => {
        db.prepare(`UPDATE registrations SET status = 'waitlist', waitlist_position = ? WHERE id = ?`)
          .run(currentMaxPos + i + 1, r.id);
      });
    }

    return { ok: true };
  })();

  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json(result);
});

app.delete('/api/sessions/:id', adminAuth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'Session non trouvée' });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/register', (req, res) => {
  const p1 = req.body.player1?.trim();
  const p2 = req.body.player2?.trim() || null;
  if (!p1) return res.status(400).json({ error: 'Le prénom est requis' });

  const result = db.transaction(() => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return { error: 'Session non trouvée', code: 404 };

    if (stmts.checkDup.get(req.params.id, p1, p1)) {
      return { error: `${p1} est déjà inscrit(e)`, code: 400 };
    }
    if (p2 && stmts.checkDup.get(req.params.id, p2, p2)) {
      return { error: `${p2} est déjà inscrit(e)`, code: 400 };
    }

    const id = randomUUID();
    const { count } = stmts.countConfirmed.get(req.params.id);

    if (count < session.max_pairs) {
      db.prepare('INSERT INTO registrations (id, session_id, player1, player2, status) VALUES (?,?,?,?,?)')
        .run(id, req.params.id, p1, p2, 'confirmed');
      return { id, status_val: 'confirmed' };
    }

    const { max } = stmts.maxWaitlistPos.get(req.params.id);
    db.prepare('INSERT INTO registrations (id, session_id, player1, player2, status, waitlist_position) VALUES (?,?,?,?,?,?)')
      .run(id, req.params.id, p1, p2, 'waitlist', max + 1);
    return { id, status_val: 'waitlist', position: max + 1 };
  })();

  if (result.error) return res.status(result.code).json({ error: result.error });
  res.status(201).json(result);
});

app.delete('/api/registrations/:id', (req, res) => {
  const result = db.transaction(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
    if (!reg) return { error: 'Inscription non trouvée', code: 404 };

    db.prepare('DELETE FROM registrations WHERE id = ?').run(req.params.id);

    if (reg.status === 'confirmed') {
      // Promouvoir le premier en liste d'attente
      const first = stmts.firstWaitlisted.get(reg.session_id);
      if (first) {
        db.prepare(`UPDATE registrations SET status = 'confirmed', waitlist_position = NULL WHERE id = ?`)
          .run(first.id);
        db.prepare(`UPDATE registrations SET waitlist_position = waitlist_position - 1
                    WHERE session_id = ? AND status = 'waitlist'`)
          .run(reg.session_id);
      }
    } else {
      // Décaler les positions suivantes
      db.prepare(`UPDATE registrations SET waitlist_position = waitlist_position - 1
                  WHERE session_id = ? AND status = 'waitlist' AND waitlist_position > ?`)
        .run(reg.session_id, reg.waitlist_position);
    }

    return { ok: true };
  })();

  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json(result);
});

// Modifier ou retirer un joueur dans une inscription existante
app.patch('/api/registrations/:id', (req, res) => {
  const { action, value } = req.body;
  if (!['remove_player1', 'remove_player2', 'update_player1', 'update_player2'].includes(action)) {
    return res.status(400).json({ error: 'Action invalide' });
  }

  const result = db.transaction(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
    if (!reg) return { error: 'Inscription non trouvée', code: 404 };

    if (action === 'remove_player2') {
      if (!reg.player2) return { error: 'Pas de deuxième joueur', code: 400 };
      db.prepare('UPDATE registrations SET player2 = NULL WHERE id = ?').run(reg.id);
      return { ok: true };
    }

    if (action === 'remove_player1') {
      if (!reg.player2) return { error: 'Utiliser DELETE pour une inscription solo', code: 400 };
      db.prepare('UPDATE registrations SET player1 = player2, player2 = NULL WHERE id = ?').run(reg.id);
      return { ok: true };
    }

    // update_player1 ou update_player2
    const newName = value?.trim();
    if (!newName) return { error: 'Le prénom est requis', code: 400 };

    // Vérifier doublon dans les autres inscriptions de la session
    const dupInOther = db.prepare(`
      SELECT id FROM registrations
      WHERE session_id = ? AND id != ?
      AND (lower(player1) = lower(?) OR (player2 IS NOT NULL AND lower(player2) = lower(?)))
    `).get(reg.session_id, reg.id, newName, newName);
    if (dupInOther) return { error: `${newName} est déjà inscrit(e)`, code: 400 };

    // Vérifier conflit avec l'autre joueur de la même inscription
    const other = action === 'update_player1' ? reg.player2 : reg.player1;
    if (other && other.toLowerCase() === newName.toLowerCase()) {
      return { error: 'Les deux joueurs doivent avoir des prénoms différents', code: 400 };
    }

    if (action === 'update_player1') {
      db.prepare('UPDATE registrations SET player1 = ? WHERE id = ?').run(newName, reg.id);
    } else {
      db.prepare('UPDATE registrations SET player2 = ? WHERE id = ?').run(newName, reg.id);
    }
    return { ok: true };
  })();

  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json(result);
});

app.post('/api/admin/verify', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD non configuré' });
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  res.json({ ok: true });
});

app.get('/api/sessions/:id/export-excel', adminAuth, (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session non trouvée' });
  const confirmed = stmts.getRegistrations.all(req.params.id).filter(r => r.status === 'confirmed');

  const rows = confirmed.map((r, i) => ({
    '#': i + 1,
    'Binôme': r.player2 ? `${r.player1} & ${r.player2}` : r.player1,
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Binômes');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="gouinche-${session.date}.xlsx"`);
  res.send(buffer);
});

// ── Nettoyage automatique des sessions > 1 mois ──────────────────────────────
function cleanupOldSessions() {
  const { changes } = db.prepare(
    `DELETE FROM sessions WHERE date < date('now', '-1 month')`
  ).run();
  if (changes > 0) console.log(`🧹 ${changes} session(s) ancienne(s) supprimée(s)`);
}

app.listen(PORT, () => {
  console.log(`Gouinche sur http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.warn('⚠  ADMIN_PASSWORD non défini — définissez la variable d\'environnement');
  cleanupOldSessions();
  setInterval(cleanupOldSessions, 24 * 60 * 60 * 1000);
});
