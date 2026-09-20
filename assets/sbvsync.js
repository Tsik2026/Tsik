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

/* ---------- ПАНДА: приглашение к модулю «Первичка» (бегущая строка + план на одобрение) ---------- */
(function(){
  var HIDE_KEY = "panda_bar_hide_v1", PLAN_KEY = "panda_plan_v1";
  var PVER = "sberpay44";
  var hiddenVer = null;
  try { hiddenVer = localStorage.getItem(HIDE_KEY); } catch (e) {}
  if (hiddenVer === PVER) {
    // Строка скрыта пользователем — показываем мини-кнопку восстановления
    var rb = document.createElement("button");
    rb.title = "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u0443 \u041F\u0430\u043D\u0434\u044B";
    rb.setAttribute("style", "position:fixed;right:10px;bottom:120px;z-index:5001;width:38px;height:38px;border:0;border-radius:50%;background:#0f1f3d;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.35);padding:0");
    rb.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="13" r="8.2" fill="#fff"/><circle cx="5.4" cy="6.6" r="3.1" fill="#222"/><circle cx="18.6" cy="6.6" r="3.1" fill="#222"/><ellipse cx="8.6" cy="12.4" rx="2.5" ry="3" fill="#222" transform="rotate(-18 8.6 12.4)"/><ellipse cx="15.4" cy="12.4" rx="2.5" ry="3" fill="#222" transform="rotate(18 15.4 12.4)"/><circle cx="9" cy="12.6" r="0.9" fill="#fff"/><circle cx="15" cy="12.6" r="0.9" fill="#fff"/><ellipse cx="12" cy="16.2" rx="1.5" ry="1.1" fill="#222"/></svg>';
    rb.addEventListener("click", function(){
      try { localStorage.removeItem(HIDE_KEY); } catch (e) {}
      location.reload();
    });
    document.addEventListener("DOMContentLoaded", function(){ document.body.appendChild(rb); });
    if (document.body) document.body.appendChild(rb);
    return;
  }

  var MSG_INVITE = "\uD83D\uDC3C Здравствуйте! Я Панда — Ваш помощник. Помогу подготовить первичку из ваших файлов: распознаю документы, рассортирую по разделам, соберу реестр для приёмки. Согласны? Нажмите на меня \uD83D\uDC49";
  var MSG_OK = "\u2705 План модуля \u00ABПервичка\u00BB утверждён! Начинаем с Фазы 1 — подключение папки и индекс документов.";

  var st = document.createElement("style");
  st.textContent = [
    "#panda-bar{position:fixed;left:0;right:0;bottom:0;z-index:5000;height:44px;background:#0f1f3d;color:#fff;display:flex;align-items:center;box-shadow:0 -3px 12px rgba(0,0,0,.35);font:13px/1.4 system-ui,sans-serif}",
    "#panda-ticker{flex:1;overflow:hidden;position:relative;height:100%;display:flex;align-items:center}",
    "#panda-track{display:inline-flex;white-space:nowrap;animation:panda-tick 32s linear infinite;will-change:transform}",
    "#panda-track span{padding-right:60px}",
    "@keyframes panda-tick{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}",
    "#panda-btn{flex:0 0 auto;width:42px;height:42px;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;animation:panda-hop 1.8s ease-in-out infinite}",
    "@keyframes panda-hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
    "#panda-close{flex:0 0 auto;width:32px;height:42px;border:0;background:transparent;color:#fff;opacity:.55;font-size:17px;cursor:pointer}",
    "#panda-close:hover{opacity:1}",
    "#panda-modal{position:fixed;inset:0;z-index:6000;background:rgba(8,12,26,.62);display:none;align-items:center;justify-content:center;padding:16px}",
    "#panda-modal.on{display:flex}",
    "#panda-box{background:#fff;color:#16233f;border-radius:16px;max-width:620px;width:100%;max-height:86vh;overflow:auto;padding:22px 24px;font:14px/1.55 system-ui,sans-serif;box-shadow:0 16px 50px rgba(0,0,0,.4)}",
    "#panda-box h2{margin:0 0 4px;font-size:19px}",
    "#panda-box .panda-sub{color:#5a6b8c;font-size:12.5px;margin-bottom:14px}",
    "#panda-box ul{margin:8px 0;padding-left:20px}",
    "#panda-box li{margin-bottom:6px}",
    "#panda-box .panda-phases{background:#f2f6fd;border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}",
    "#panda-box .panda-act{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}",
    "#panda-box button{border:0;border-radius:10px;padding:11px 18px;font:600 13.5px system-ui,sans-serif;cursor:pointer}",
    "#panda-yes{background:#21A038;color:#fff}",
    "#panda-later{background:#e6ebf5;color:#16233f}"
  ].join("\n");
  document.head.appendChild(st);

  var bar = document.createElement("div");
  bar.id = "panda-bar";
  bar.innerHTML =
    '<div id="panda-ticker"><div id="panda-track"><span>' + MSG_INVITE + '</span><span>' + MSG_INVITE + '</span></div></div>' +
    '<button id="panda-btn" title="Открыть план модуля \u00ABПервичка\u00BB" aria-label="Панда — помощник">' +
    '<svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="13" r="8.2" fill="#fff"/>' +
    '<circle cx="5.4" cy="6.6" r="3.1" fill="#222"/><circle cx="18.6" cy="6.6" r="3.1" fill="#222"/>' +
    '<ellipse cx="8.6" cy="12.4" rx="2.5" ry="3" fill="#222" transform="rotate(-18 8.6 12.4)"/>' +
    '<ellipse cx="15.4" cy="12.4" rx="2.5" ry="3" fill="#222" transform="rotate(18 15.4 12.4)"/>' +
    '<circle cx="9" cy="12.6" r="0.9" fill="#fff"/><circle cx="15" cy="12.6" r="0.9" fill="#fff"/>' +
    '<ellipse cx="12" cy="16.2" rx="1.5" ry="1.1" fill="#222"/></svg></button>' +
    '<button id="panda-close" title="Скрыть строку">\u00D7</button>';
  document.body.appendChild(bar);
  function placeBar(){
    var h = 0;
    var els = document.querySelectorAll("nav, footer, [role=navigation]");
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.top > window.innerHeight * 0.6 && r.height > 20 && r.height < 160) { h = r.height; break; }
    }
    bar.style.bottom = ((h || 64) + 2) + "px";
  }
  placeBar();
  window.addEventListener("resize", placeBar);

  var modal = document.createElement("div");
  modal.id = "panda-modal";
  modal.innerHTML = '<div id="panda-box">' +
    '<h2>\uD83D\uDC3C Модуль \u00ABПервичка\u00BB</h2>' +
    '<div class="panda-sub">Предложение на одобрение \u00B7 интеллектуальная приёмка первичных документов \u00B7 работает на вашем устройстве, офлайн, данные не покидают приложение</div>' +
    '<ul>' +
    '<li><b>Одна папка с подпапками</b> — подключаете один раз через системный диалог, доступ сохраняется</li>' +
    '<li><b>Автоматическое распознавание</b> — текстовый слой PDF/DOCX/XLSX/CSV и OCR для сканов и фото</li>' +
    '<li><b>Классификация по нормативному перечню</b> — 18 типов первичных документов (402-ФЗ, НК РФ, указания ЦИК):</li>' +
    '<li style="list-style:none;padding-left:8px;font-size:13px">1. Платёжное поручение (исходящее) \u00B7 2. Счёт на оплату \u00B7 3. Акт выполненных работ/услуг \u00B7 4. Договор (ГПХ/подряд/услуги) \u00B7 5. Ведомость на выплату вознаграждений \u00B7 6. Банковская выписка \u00B7 7. Кассовые документы (ПКО/РКО) \u00B7 8. Авансовый отчёт \u00B7 9. Счёт-фактура \u00B7 10. Накладная/требование \u00B7 11. Бухгалтерская справка \u00B7 12. Акт сверки \u00B7 13. Протокол комиссии (о расходовании средств) \u00B7 14. Смета расходов комиссии \u00B7 15. Отчёт о расходовании средств \u00B7 16. Чеки/БСО \u00B7 17. Справки/реестры по НДФЛ \u00B7 18. Доверенность</li>' +
    '<li><b>Извлечение реквизитов</b> — номер, дата, сумма, ИНН, № УИК/ТИК, отчётный период</li>' +
    '<li><b>Ничего без вашего утверждения</b> — сначала экран подтверждения с ручной корректировкой каждого файла</li>' +
    '<li><b>Дедупликация</b> — повторные файлы не попадут в базу дважды</li>' +
    '<li><b>Журнал приёмки и реестр</b> — след для контрольного органа, выгрузка в Excel</li>' +
    '</ul>' +
    '<div class="panda-phases"><b>Этапы:</b> 1) Подключение папки и индекс \u2192 2) Распознавание и реквизиты \u2192 3) Классификация и раскладка по разделам \u2192 4) Журнал и реестр. После каждой фазы — публикация и ваша проверка.</div>' +
    '<div class="panda-act"><button id="panda-yes">\u2705 Утверждаю план — начать Фазу 1</button><button id="panda-later">Позже</button></div>' +
    '</div>';
  document.body.appendChild(modal);

  function setMsg(t){
    var track = document.getElementById("panda-track");
    if (track) track.innerHTML = "<span>" + t + "</span><span>" + t + "</span>";
  }
  try { if (localStorage.getItem(PLAN_KEY) === "approved") setMsg(MSG_OK); } catch (e) {}

  document.getElementById("panda-btn").addEventListener("click", function(){ modal.classList.add("on"); });
  modal.addEventListener("click", function(e){
    if (e.target === modal || e.target.id === "panda-later") modal.classList.remove("on");
    if (e.target.id === "panda-yes") {
      try { localStorage.setItem(PLAN_KEY, "approved"); } catch (err) {}
      setMsg(MSG_OK);
      modal.classList.remove("on");
    }
  });
  document.getElementById("panda-close").addEventListener("click", function(){
    try { localStorage.setItem(HIDE_KEY, PVER); } catch (e) {}
    bar.remove();
    location.reload();
  });
})();
