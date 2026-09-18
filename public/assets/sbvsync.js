/* ============================================================
   Фоновая синхронизация списков УИК (автоперехват)
   Работает молча: при каждом запуске приложения и каждые 10 минут
   проверяет комиссии с демонстрационными составами и обновляет их
   из доступных источников (общий список, реестр вкладки Сбербанк),
   если источник достоверно соответствует комиссии (перекрытие ФИО ≥50%).
   Не мешает пользователю: без диалогов, без блокировок интерфейса.
   ============================================================ */
(function(){
  const KEY_STATUS = "sbv_syncstatus_v1";
  let busy = false;
  const normFio = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const RATES = { chair: 63, deputy: 57, secretary: 57, member: 45 };
  function mapRole(v){
    const s = String(v || "").toLowerCase();
    if (/председат/.test(s)) return "chair";
    if (/замест/.test(s)) return "deputy";
    if (/секретар/.test(s)) return "secretary";
    return "member";
  }
  function sources(){
    const out = [];
    try {
      const m = JSON.parse(localStorage.getItem("sbv_master_v1") || "null");
      if (m && m.rows && m.rows.length)
        out.push({ name: "Общий список", list: m.rows.map(r => ({ fio: r.fio, role: mapRole("") })).filter(x => x.fio) });
    } catch (e) {}
    try {
      const reg = JSON.parse(localStorage.getItem("sbv_registry_v1") || "[]");
      for (const e of reg) {
        if (!e.rows || !e.rows.length) continue;
        const list = e.rows
          .map(r => ({ fio: [r.last, r.first, r.middle].join(" ").trim(), role: r.__role || mapRole("") }))
          .filter(x => x.fio);
        if (list.length) out.push({ name: e.name, list });
      }
    } catch (e) {}
    return out;
  }
  async function syncOnce(){
    if (busy) return;
    busy = true;
    try {
      const db = window.__db;
      if (!db || !db.commissions || !db.members) return;
      const srcs = sources();
      if (!srcs.length) return;
      const comms = (await db.commissions.toArray()).filter(c => c.level === "UIK");
      let updated = 0, people = 0;
      for (const c of comms) {
        const members = await db.members.where("commissionId").equals(c.id).toArray();
        const demos = members.filter(m => m.source === "demo");
        if (!demos.length) continue; // состав уже актуальный
        const demoSet = new Set(demos.map(m => normFio(m.fio)));
        let best = null;
        for (const s of srcs) {
          const set = new Set(s.list.map(x => normFio(x.fio)));
          let hit = 0;
          for (const d of demoSet) if (set.has(d)) hit++;
          const ratio = demoSet.size ? hit / demoSet.size : 0;
          if (ratio >= 0.5 && (!best || ratio > best.ratio)) best = { name: s.name, list: s.list, ratio };
        }
        if (!best) continue;
        const incoming = new Map(best.list.map(x => [normFio(x.fio), x]));
        await db.transaction("rw", db.members, async () => {
          for (const m of members) {
            const k = normFio(m.fio);
            if (m.source === "demo") {
              if (incoming.has(k)) {
                const role = incoming.get(k).role && incoming.get(k).role !== "member" ? incoming.get(k).role : m.role;
                await db.members.update(m.id, { source: "official", role });
              } else await db.members.delete(m.id);
            }
          }
          const have = new Set((await db.members.where("commissionId").equals(c.id).toArray()).map(m => normFio(m.fio)));
          const fresh = best.list
            .filter(x => !have.has(normFio(x.fio)))
            .map(x => ({ commissionId: c.id, fio: x.fio, role: x.role || "member", status: "нештатный", rate: RATES[x.role] || 45, source: "official" }));
          if (fresh.length) await db.members.bulkAdd(fresh);
        });
        updated++; people += best.list.length;
      }
      if (updated) {
        const st = { date: new Date().toLocaleString("ru-RU"), updated, people };
        try { localStorage.setItem(KEY_STATUS, JSON.stringify(st)); } catch (e) {}
        window.dispatchEvent(new CustomEvent("sbv-sync", { detail: st }));
      }
    } catch (e) { /* молча, не мешаем работе */ }
    finally { busy = false; }
  }
  function start(){
    if (window.__db) { syncOnce(); setInterval(syncOnce, 10 * 60 * 1000); }
    else setTimeout(start, 2000);
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();

/* ---------- автобэкап базы (фон, каждые 5 минут, без участия пользователя) ---------- */
const BK_KEY = "komfin_autobackup_v1";
let bkBusy = false, bkTick = 0;
function bkSnapshot(){
  const db = window.__db;
  if (!db) return Promise.resolve(null);
  const dump = { app: "komfin", format: 2, at: new Date().toISOString(), tables: {} };
  return Promise.all(db.tables.map(t => t.toArray().then(rows => { dump.tables[t.name] = rows; }))).then(() => JSON.stringify(dump));
}
function bkRun(){
  if (bkBusy) return;
  bkBusy = true;
  bkSnapshot().then(json => {
    if (!json) return;
    try { localStorage.setItem(BK_KEY, json); } catch (e) {}
    bkTick++;
    if (bkTick % 6 === 0) {
      const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "komfin_autobackup_" + date + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }).catch(() => {}).finally(() => { bkBusy = false; });
}
setTimeout(bkRun, 90 * 1000);
setInterval(bkRun, 5 * 60 * 1000);
