const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TOKEN = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const ARSIV_DATABASE_ID = process.env.ARSIV_DATABASE_ID;
const TEKRAR_DATABASE_ID = process.env.TEKRAR_DATABASE_ID;
const SHIFT_DATABASE_ID = process.env.SHIFT_DATABASE_ID;
const CHAT_ID = process.env.CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });
const notion = new Client({ auth: NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const kullaniciDurum = {};

const SHIFT_SAATLERI = {
  'A': { baslangic: 9, bitis: 17 },
  'B': { baslangic: 14, bitis: 22 },
  'C': { baslangic: 20, bitis: 28 }
};

const IZIN_SHIFT_KARSILIGI = {
  'A': { shift: 'B', baslangic: 9, bitis: 17 },
  'B': { shift: 'C', baslangic: 17, bitis: 25 },
  'C': { shift: 'B', baslangic: 17, bitis: 25 }
};

function oncelikEmoji(oncelik) {
  if (!oncelik) return '⚪';
  const o = oncelik.toUpperCase();
  if (o.includes('KRIT')) return '🔴';
  if (o.includes('YÜKSEK') || o.includes('YUKSEK')) return '🟡';
  if (o.includes('NORMAL')) return '🟢';
  if (o.includes('BEKLEM')) return '🔵';
  return '⚪';
}

function tarihFormat(tarihStr) {
  if (!tarihStr) return '-';
  try {
    const d = new Date(tarihStr);
    const gun = String(d.getDate()).padStart(2, '0');
    const ay = String(d.getMonth() + 1).padStart(2, '0');
    const yil = d.getFullYear();
    const saat = String(d.getHours()).padStart(2, '0');
    const dakika = String(d.getMinutes()).padStart(2, '0');
    return `${gun}.${ay}.${yil} ${saat}:${dakika}`;
  } catch (e) { return tarihStr; }
}

function bugunTarih() {
  const d = new Date();
  const gun = String(d.getDate()).padStart(2, '0');
  const ay = String(d.getMonth() + 1).padStart(2, '0');
  const yil = d.getFullYear();
  return `${gun}.${ay}.${yil}`;
}

function haftaNumarasi(tarih = new Date()) {
  const d = new Date(Date.UTC(tarih.getFullYear(), tarih.getMonth(), tarih.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function gunAdi(tarih = new Date()) {
  const gunler = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  return gunler[tarih.getDay()];
}

function notionMetinAl(prop) {
  if (!prop) return '-';
  if (prop.type === 'title' && prop.title) return prop.title.map(t => t.plain_text).join('') || '-';
  if (prop.type === 'rich_text' && prop.rich_text) return prop.rich_text.map(t => t.plain_text).join('') || '-';
  if (prop.type === 'select' && prop.select) return prop.select.name || '-';
  if (prop.type === 'date' && prop.date) return tarihFormat(prop.date.start);
  if (prop.type === 'checkbox') return prop.checkbox ? 'Evet' : 'Hayır';
  return '-';
}

function altMaddeleriParse(notlar) {
  if (!notlar || notlar === '-') return [];
  return notlar.split('\n')
    .filter(s => s.trim().startsWith('☐') || s.trim().startsWith('☑'))
    .map((s, i) => ({
      index: i,
      tamamlandi: s.trim().startsWith('☑'),
      metin: s.trim().replace('☐ ', '').replace('☑ ', '').trim()
    }));
}

function altMaddeleriYaz(maddeler) {
  return maddeler.map(m => `${m.tamamlandi ? '☑' : '☐'} ${m.metin}`).join('\n');
}

async function mesajGonder(chatId, metin, klavye) {
  const opts = { parse_mode: 'HTML' };
  if (klavye) opts.reply_markup = klavye;
  try {
    await bot.sendMessage(chatId, metin, opts);
  } catch (e) {
    console.error('Mesaj gönderme hatası:', e.message);
  }
}

async function buHaftanınShiftiniGetir() {
  const hafta = haftaNumarasi();
  try {
    const response = await notion.databases.query({
      database_id: SHIFT_DATABASE_ID,
      filter: { property: 'Hafta', title: { equals: hafta } }
    });
    if (response.results.length > 0) return response.results[0];
    return null;
  } catch (e) {
    console.error('Shift getirme hatası:', e.message);
    return null;
  }
}

function shiftBilgisiniParse(metin) {
  const kisiler = {};
  const izinler = {};
  const shiftRegex = /([ABC])\s*shifti\s+(\w+)/gi;
  let match;
  while ((match = shiftRegex.exec(metin)) !== null) {
    kisiler[match[2]] = match[1].toUpperCase();
  }
  const izinRegex = /(\w+)\s+(Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi|Pazar)\s+izin/gi;
  while ((match = izinRegex.exec(metin)) !== null) {
    izinler[match[1]] = match[2];
  }
  return { kisiler, izinler };
}

function suAnMesaideKimVar(shiftData, saat = null) {
  if (!shiftData) return [];
  const props = shiftData.properties;
  const trSimdi = new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
  const bugunGun = gunAdi(trSimdi);
  const simdi = saat !== null ? saat : trSimdi.getUTCHours() + trSimdi.getUTCMinutes() / 60;
  const mesaideOlanlar = [];
  const kisiler = [
    { ad: 'Can', shiftProp: 'Can_Shift', izinProp: 'Can_Izin' },
    { ad: 'Deaven', shiftProp: 'Deaven_Shift', izinProp: 'Deaven_Izin' },
    { ad: 'BL', shiftProp: 'BL_Shift', izinProp: 'BL_Izin' }
  ];
  for (const kisi of kisiler) {
    const shiftHarfi = notionMetinAl(props[kisi.shiftProp]);
    const izinGunu = notionMetinAl(props[kisi.izinProp]);
    if (shiftHarfi === '-') continue;
    const izinli = izinGunu !== '-' && izinGunu === bugunGun;
    if (izinli) continue;
    let baslangic = SHIFT_SAATLERI[shiftHarfi]?.baslangic;
    let bitis = SHIFT_SAATLERI[shiftHarfi]?.bitis;
    for (const digerKisi of kisiler) {
      if (digerKisi.ad === kisi.ad) continue;
      const digerShift = notionMetinAl(props[digerKisi.shiftProp]);
      const digerIzin = notionMetinAl(props[digerKisi.izinProp]);
      if (digerIzin !== '-' && digerIzin === bugunGun) {
        const karsilik = IZIN_SHIFT_KARSILIGI[digerShift];
        if (karsilik && karsilik.shift === shiftHarfi) {
          baslangic = karsilik.baslangic;
          bitis = karsilik.bitis;
        }
      }
    }
    if (baslangic === undefined || bitis === undefined) continue;
    const normalizeSimdi = simdi < 5 ? simdi + 24 : simdi;
    if (normalizeSimdi >= baslangic && normalizeSimdi < bitis) {
      mesaideOlanlar.push(kisi.ad);
    }
  }
  return mesaideOlanlar;
}

async function shiftKaydet(metin, chatId) {
  const { kisiler, izinler } = shiftBilgisiniParse(metin);
  if (Object.keys(kisiler).length === 0) {
    await mesajGonder(chatId, '❌ Shift bilgisi anlaşılamadı. Format: "C shifti BL B shifti Can A shifti Deaven BL Çarşamba izin, Can Perşembe izin"');
    return;
  }
  const hafta = haftaNumarasi();
  const mevcut = await buHaftanınShiftiniGetir();
  const properties = {
    'Hafta': { title: [{ text: { content: hafta } }] },
    'Can_Shift': { rich_text: [{ text: { content: kisiler['Can'] || '' } }] },
    'Can_Izin': { rich_text: [{ text: { content: izinler['Can'] || '' } }] },
    'Deaven_Shift': { rich_text: [{ text: { content: kisiler['Deaven'] || '' } }] },
    'Deaven_Izin': { rich_text: [{ text: { content: izinler['Deaven'] || '' } }] },
    'BL_Shift': { rich_text: [{ text: { content: kisiler['BL'] || '' } }] },
    'BL_Izin': { rich_text: [{ text: { content: izinler['BL'] || '' } }] }
  };
  if (mevcut) {
    await notion.pages.update({ page_id: mevcut.id, properties });
  } else {
    await notion.pages.create({ parent: { database_id: SHIFT_DATABASE_ID }, properties });
  }
  const shiftMetin = Object.entries(kisiler).map(([kisi, shift]) => {
    const saatler = SHIFT_SAATLERI[shift];
    const izin = izinler[kisi] ? ` (İzin: ${izinler[kisi]})` : '';
    const baslangicStr = String(saatler?.baslangic || 0).padStart(2, '0') + ':00';
    const bitisRaw = saatler?.bitis || 0;
    const bitisStr = String(bitisRaw > 24 ? bitisRaw - 24 : bitisRaw).padStart(2, '0') + ':00';
    return `👤 ${kisi} → ${shift} Shifti (${baslangicStr}-${bitisStr})${izin}`;
  }).join('\n');
  await mesajGonder(chatId, `✅ <b>${hafta} Shift Kaydedildi</b>\n━━━━━━━━━━━━━━━\n\n${shiftMetin}`);
}

async function acikIsleriGetir(oncelikFiltre = null) {
  const filter = oncelikFiltre
    ? { and: [{ property: 'DURUM', select: { equals: 'AÇIK' } }, { property: 'ÖNCELİK', select: { equals: oncelikFiltre } }] }
    : { property: 'DURUM', select: { equals: 'AÇIK' } };
  const response = await notion.databases.query({ database_id: DATABASE_ID, filter });
  return response.results;
}

async function bitenIsleriGetir(tarihStr = null) {
  let hedefTarih = null;
  if (tarihStr) {
    const parcalar = tarihStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (parcalar) hedefTarih = `${parcalar[3]}-${parcalar[2].padStart(2, '0')}-${parcalar[1].padStart(2, '0')}`;
  } else {
    const bugun = new Date();
    hedefTarih = `${bugun.getFullYear()}-${String(bugun.getMonth() + 1).padStart(2, '0')}-${String(bugun.getDate()).padStart(2, '0')}`;
  }
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: 'DURUM', select: { equals: 'BİTTİ' } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
  });
  const results = response.results.filter(is => is.last_edited_time?.startsWith(hedefTarih));
  return { results, tarih: hedefTarih };
}

async function yeniIsOlustur(isAdi, oncelik, sorumlu, deadline, altMaddeler) {
  const properties = {
    'İş Başlığı': { title: [{ text: { content: isAdi } }] },
    'DURUM': { select: { name: 'AÇIK' } },
    'ÖNCELİK': { select: { name: oncelik } },
    'SORUMLU': { rich_text: [{ text: { content: sorumlu } }] }
  };
  if (deadline && deadline.toLowerCase() !== 'yok') {
    try {
      const parcalar = deadline.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (parcalar) {
        properties['Deanline'] = { date: { start: `${parcalar[3]}-${parcalar[2].padStart(2,'0')}-${parcalar[1].padStart(2,'0')}T${parcalar[4].padStart(2,'0')}:${parcalar[5]}:00` } };
      }
    } catch (e) { }
  }
  if (altMaddeler && altMaddeler.toLowerCase() !== 'yok') {
    const maddeler = altMaddeler.split(',').map(m => `☐ ${m.trim()}`).join('\n');
    properties['NOTLAR'] = { rich_text: [{ text: { content: maddeler } }] };
  }
  return await notion.pages.create({ parent: { database_id: DATABASE_ID }, properties });
}

async function isGuncelle(pageId, properties) {
  return await notion.pages.update({ page_id: pageId, properties });
}

async function isArsivle(page) {
  const baslik = notionMetinAl(page.properties['İş Başlığı']);
  const oncelik = notionMetinAl(page.properties['ÖNCELİK']);
  const sorumlu = notionMetinAl(page.properties['SORUMLU']);
  await notion.pages.create({
    parent: { database_id: ARSIV_DATABASE_ID },
    properties: {
      'İş Başlığı': { title: [{ text: { content: baslik } }] },
      'DURUM': { select: { name: 'BİTTİ' } },
      'ÖNCELİK': { select: { name: oncelik === '-' ? 'NORMAL' : oncelik } },
      'SORUMLU': { rich_text: [{ text: { content: sorumlu === '-' ? '' : sorumlu } }] },
      'Arşivlenme Tarihi': { date: { start: new Date().toISOString() } }
    }
  });
  await notion.pages.update({ page_id: page.id, archived: true });
}

async function bitenIsBildirimiGonder(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const baslik = notionMetinAl(page.properties['İş Başlığı']);
    const sorumlu = notionMetinAl(page.properties['SORUMLU']);
    const oncelik = notionMetinAl(page.properties['ÖNCELİK']);
    await bot.sendMessage(CHAT_ID, `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}\n\nTebrikler! 🎉`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Biten iş bildirimi hatası:', e.message);
  }
}

async function kritikIsleriiBildir() {
  try {
    const isler = await acikIsleriGetir('KRİTİK');
    if (isler.length === 0) return;
    let metin = `🔴 <b>KRİTİK AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      metin += `🔴 <b>${baslik}</b>\n👤 ${sorumlu}\n⏰ ${deadline}\n\n`;
    }
    await bot.sendMessage(CHAT_ID, metin, { parse_mode: 'HTML' });
  } catch (e) { console.error('Kritik bildirim hatası:', e.message); }
}

async function yuksekIsleriiBildir() {
  try {
    const isler = await acikIsleriGetir('YÜKSEK');
    if (isler.length === 0) return;
    let metin = `🟡 <b>YÜKSEK ÖNCELİKLİ AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      metin += `🟡 <b>${baslik}</b>\n👤 ${sorumlu}\n⏰ ${deadline}\n\n`;
    }
    await bot.sendMessage(CHAT_ID, metin, { parse_mode: 'HTML' });
  } catch (e) { console.error('Yüksek bildirim hatası:', e.message); }
}

async function tekrarEdenIsleriGetir() {
  try {
    const response = await notion.databases.query({ database_id: TEKRAR_DATABASE_ID });
    return response.results;
  } catch (e) {
    console.error('Tekrar eden işler getirme hatası:', e.message);
    return [];
  }
}

function tekrarTetiklenmelimi(is, simdi = new Date()) {
  const trSimdi = new Date(simdi.getTime() + 3 * 60 * 60 * 1000);
  const tip = notionMetinAl(is.properties['TEKRAR_TİPİ']);
  const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
  const saatStr = notionMetinAl(is.properties['TEKRAR_SAATİ']);
  const sonTetikleme = is.properties['SON_TETIKLEME']?.date?.start;
  if (!saatStr || saatStr === '-') return false;
  const [hedefSaat, hedefDakika] = saatStr.split(':').map(Number);
  const hedefToplam = hedefSaat * 60 + hedefDakika;
  const simdikiToplam = trSimdi.getUTCHours() * 60 + trSimdi.getUTCMinutes();
  if (Math.abs(hedefToplam - simdikiToplam) > 2) return false;
  if (sonTetikleme) {
    const farkDk = (simdi - new Date(sonTetikleme)) / 60000;
    if (farkDk < 60) return false;
  }
  const bugunGunAdi = gunAdi(trSimdi);
  const bugunGunNo = trSimdi.getUTCDate();
  if (tip === 'Günlük') return true;
  if (tip === 'Haftalık') return gun === bugunGunAdi;
  if (tip === 'Aylık') return String(bugunGunNo) === String(gun);
  return false;
}

async function tekrarEdenIsleriKontrolEt() {
  const isler = await tekrarEdenIsleriGetir();
  const shiftData = await buHaftanınShiftiniGetir();
  const simdi = new Date();
  for (const is of isler) {
    if (!tekrarTetiklenmelimi(is, simdi)) continue;
    const baslik = notionMetinAl(is.properties['İş Başlığı']);
    const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
    const altMaddeler = notionMetinAl(is.properties['ALT_MADDELER']);
    const mesaideOlanlar = suAnMesaideKimVar(shiftData);
    const sorumlu = mesaideOlanlar.length > 0 ? mesaideOlanlar.join(', ') : 'Belirsiz';
    try {
      const otomatikNot = `Otomatik açıldı,Kim yaptı: ${sorumlu}`;
      const altMaddelerGonder = altMaddeler !== '-' ? altMaddeler + ',' + otomatikNot : otomatikNot;
      await yeniIsOlustur(baslik, oncelik === '-' ? 'NORMAL' : oncelik, sorumlu, 'yok', altMaddelerGonder);
      await notion.pages.update({ page_id: is.id, properties: { 'SON_TETIKLEME': { date: { start: simdi.toISOString() } } } });
      await bot.sendMessage(CHAT_ID, `🔁 <b>TEKRAR EDEN İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Tekrar eden iş oluşturma hatası:', e.message);
    }
  }
}

async function tekrarEdenIsEkle(chatId, durum, metin) {
  if (durum.adim === 'tekrar_isim') {
    durum.isAdi = metin;
    durum.adim = 'tekrar_oncelik';
    await mesajGonder(chatId, `✅ İş adı: <b>${metin}</b>\n\n<b>2/5 — Öncelik?</b>`, {
      keyboard: [[{ text: '🔴 KRİTİK' }, { text: '🟡 YÜKSEK' }], [{ text: '🟢 NORMAL' }, { text: '🔵 BEKLEMEDE' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'tekrar_oncelik') {
    durum.oncelik = metin.replace('🔴 ', '').replace('🟡 ', '').replace('🟢 ', '').replace('🔵 ', '');
    durum.adim = 'tekrar_tip';
    await mesajGonder(chatId, `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/5 — Tekrar tipi?</b>`, {
      keyboard: [[{ text: 'Günlük' }, { text: 'Haftalık' }], [{ text: 'Aylık' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'tekrar_tip') {
    durum.tekrarTip = metin;
    if (metin === 'Günlük') {
      durum.tekrarGun = 'Her Gün';
      durum.adim = 'tekrar_saat';
      await mesajGonder(chatId, `✅ Tip: <b>Günlük</b>\n\n<b>4/5 — Saat? (örn: 09:00)</b>`, { remove_keyboard: true });
    } else if (metin === 'Haftalık') {
      durum.adim = 'tekrar_gun';
      await mesajGonder(chatId, `✅ Tip: <b>Haftalık</b>\n\n<b>4/5 — Hangi gün?</b>`, {
        keyboard: [[{ text: 'Pazartesi' }, { text: 'Salı' }, { text: 'Çarşamba' }], [{ text: 'Perşembe' }, { text: 'Cuma' }, { text: 'Cumartesi' }], [{ text: 'Pazar' }]],
        one_time_keyboard: true, resize_keyboard: true
      });
    } else if (metin === 'Aylık') {
      durum.adim = 'tekrar_gun';
      await mesajGonder(chatId, `✅ Tip: <b>Aylık</b>\n\n<b>4/5 — Ayın kaçında? (örn: 1, 15)</b>`, { remove_keyboard: true });
    }
  } else if (durum.adim === 'tekrar_gun') {
    durum.tekrarGun = metin;
    durum.adim = 'tekrar_saat';
    await mesajGonder(chatId, `✅ Gün: <b>${metin}</b>\n\n<b>5/5 — Saat? (örn: 09:00)</b>`, { remove_keyboard: true });
  } else if (durum.adim === 'tekrar_saat') {
    durum.tekrarSaat = metin;
    durum.adim = 'tekrar_altmaddeler';
    await mesajGonder(chatId, `✅ Saat: <b>${metin}</b>\n\n<b>Alt maddeler? (virgülle yaz veya "yok")</b>`);
  } else if (durum.adim === 'tekrar_altmaddeler') {
    durum.altMaddeler = metin;
    delete kullaniciDurum[chatId];
    try {
      const properties = {
        'İş Başlığı': { title: [{ text: { content: durum.isAdi } }] },
        'ÖNCELİK': { select: { name: durum.oncelik } },
        'TEKRAR_TİPİ': { select: { name: durum.tekrarTip } },
        'TEKRAR_GÜNÜ': { rich_text: [{ text: { content: durum.tekrarGun || 'Her Gün' } }] },
        'TEKRAR_SAATİ': { rich_text: [{ text: { content: durum.tekrarSaat } }] }
      };
      if (durum.altMaddeler && durum.altMaddeler.toLowerCase() !== 'yok') {
        properties['ALT_MADDELER'] = { rich_text: [{ text: { content: durum.altMaddeler } }] };
      }
      await notion.pages.create({ parent: { database_id: TEKRAR_DATABASE_ID }, properties });
      await mesajGonder(chatId, `✅ <b>TEKRAR EDEN İŞ KAYDEDİLDİ</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(durum.oncelik)} <b>${durum.isAdi}</b>\n🔁 ${durum.tekrarTip} — ${durum.tekrarGun || 'Her Gün'} ${durum.tekrarSaat}`);
    } catch (e) {
      await mesajGonder(chatId, '❌ Hata: ' + e.message);
    }
  }
}

// =========================================
//   GEMINI AI FONKSİYONLARI
// =========================================

async function notionContextOlustur() {
  try {
    const acikIsler = await acikIsleriGetir();
    const shiftData = await buHaftanınShiftiniGetir();
    const mesaideOlanlar = suAnMesaideKimVar(shiftData);
    const trSimdi = new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
    const saatStr = `${String(trSimdi.getUTCHours()).padStart(2, '0')}:${String(trSimdi.getUTCMinutes()).padStart(2, '0')}`;

    let context = `Bugün: ${bugunTarih()}, Saat: ${saatStr}\n`;
    context += `Şu an mesaide: ${mesaideOlanlar.length > 0 ? mesaideOlanlar.join(', ') : 'Belirsiz'}\n\n`;

    if (acikIsler.length === 0) {
      context += 'Açık iş yok.\n';
    } else {
      context += `Açık işler (${acikIsler.length}):\n`;
      for (const is of acikIsler) {
        const baslik = notionMetinAl(is.properties['İş Başlığı']);
        const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
        const sorumlu = notionMetinAl(is.properties['SORUMLU']);
        const deadline = notionMetinAl(is.properties['Deanline']);
        context += `- [${oncelik}] ${baslik} | Sorumlu: ${sorumlu} | Deadline: ${deadline}\n`;
      }
    }

    return context;
  } catch (e) {
    return 'Notion verisi alınamadı.';
  }
}

async function geminiCevapAl(chatId, kullaniciMesaji) {
  const notionContext = await notionContextOlustur();

  const sistemPrompt = `Sen bir iş takip asistanısın. Ekibin Telegram botunda çalışıyorsun.
Türkçe konuş, samimi ve kısa cevaplar ver.
Notion'daki güncel veriler:
${notionContext}
Kullanıcı sana işler hakkında soru sorabilir, yorum yapabilir veya sadece sohbet edebilir.`;

  if (!kullaniciDurum[chatId].mesajlar) {
    kullaniciDurum[chatId].mesajlar = [];
  }

  kullaniciDurum[chatId].mesajlar.push({
    role: 'user',
    parts: [{ text: kullaniciMesaji }]
  });

  // Geçmişi max 20 mesajla sınırla
  if (kullaniciDurum[chatId].mesajlar.length > 20) {
    kullaniciDurum[chatId].mesajlar = kullaniciDurum[chatId].mesajlar.slice(-20);
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-preview-0520',
    systemInstruction: sistemPrompt
  });

  const chat = model.startChat({
    history: kullaniciDurum[chatId].mesajlar.slice(0, -1)
  });

  const result = await chat.sendMessage(kullaniciMesaji);
  const cevap = result.response.text();

  kullaniciDurum[chatId].mesajlar.push({
    role: 'model',
    parts: [{ text: cevap }]
  });

  return cevap;
}

// =========================================
//   TELEGRAM KOMUTLARI
// =========================================

bot.onText(/\/acik/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '📋 <b>AÇIK İŞLER</b>\n━━━━━━━━━━━━━━━\n\n🎉 Açık iş yok, her şey temiz!');
      return;
    }
    let metin = `📋 <b>AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    const gruplar = { 'KRİTİK': [], 'YÜKSEK': [], 'NORMAL': [], 'BEKLEMEDE': [], 'DİĞER': [] };
    for (const is of isler) {
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']).toUpperCase();
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      const altMaddeBilgi = maddeler.length > 0 ? ` (${tamamlanan}/${maddeler.length})` : '';
      const isKarti = `${oncelikEmoji(oncelik)} <b>${baslik}</b>${altMaddeBilgi}\n👤 ${sorumlu}\n⏰ ${deadline}`;
      if (gruplar[oncelik]) gruplar[oncelik].push(isKarti);
      else gruplar['DİĞER'].push(isKarti);
    }
    for (const grup of [{ key: 'KRİTİK', emoji: '🔴' }, { key: 'YÜKSEK', emoji: '🟡' }, { key: 'NORMAL', emoji: '🟢' }, { key: 'BEKLEMEDE', emoji: '🔵' }, { key: 'DİĞER', emoji: '⚪' }]) {
      if (gruplar[grup.key].length > 0) {
        metin += `${grup.emoji} <b>${grup.key}</b>\n`;
        metin += gruplar[grup.key].join('\n\n') + '\n\n';
      }
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/kritik/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('KRİTİK');
    if (isler.length === 0) { await mesajGonder(chatId, '🔴 Açık kritik iş yok!'); return; }
    let metin = `🔴 <b>KRİTİK (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      const altMadde = maddeler.length > 0 ? `\n📝 ${tamamlanan}/${maddeler.length} madde` : '';
      metin += `🔴 <b>${baslik}</b>\n👤 ${sorumlu}\n⏰ ${deadline}${altMadde}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/yüksek|\/yuksek/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('YÜKSEK');
    if (isler.length === 0) { await mesajGonder(chatId, '🟡 Açık yüksek öncelikli iş yok!'); return; }
    let metin = `🟡 <b>YÜKSEK (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      metin += `🟡 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/normal/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('NORMAL');
    if (isler.length === 0) { await mesajGonder(chatId, '🟢 Açık normal iş yok!'); return; }
    let metin = `🟢 <b>NORMAL (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      metin += `🟢 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/biten(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tarihParam = match[1]?.trim() || null;
  try {
    const { results: isler, tarih } = await bitenIsleriGetir(tarihParam);
    const tarihGoster = tarihParam || bugunTarih();
    if (isler.length === 0) {
      await mesajGonder(chatId, `📋 <b>BİTEN İŞLER — ${tarihGoster}</b>\n━━━━━━━━━━━━━━━\n\n📭 Bu tarihte biten iş yok.`);
      return;
    }
    let metin = `📋 <b>BİTEN İŞLER — ${tarihGoster} (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      metin += `${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/arsivle/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const response = await notion.databases.query({ database_id: DATABASE_ID, filter: { property: 'DURUM', select: { equals: 'BİTTİ' } } });
    const isler = response.results;
    if (isler.length === 0) { await mesajGonder(chatId, '🗂️ Arşivlenecek biten iş yok.'); return; }
    await mesajGonder(chatId, `⏳ ${isler.length} iş arşivleniyor...`);
    let basarili = 0;
    for (const is of isler) {
      try { await isArsivle(is); basarili++; } catch (e) { console.error('Arşivleme hatası:', e.message); }
    }
    await bot.sendMessage(CHAT_ID, `🗂️ <b>${basarili} İŞ ARŞİVLENDİ</b>\n━━━━━━━━━━━━━━━\n\nİyi geceler ekip 😴`, { parse_mode: 'HTML' });
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tamamla/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) { await mesajGonder(chatId, '📋 Açık iş yok.'); return; }
    let metin = '📋 <b>Hangi işi tamamlıyorsunuz?</b>\n━━━━━━━━━━━━━━━\n\n';
    isler.forEach((is, i) => {
      metin += `${i + 1}. ${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} ${notionMetinAl(is.properties['İş Başlığı'])}\n`;
    });
    metin += '\nNumara yaz (örn: 2)';
    kullaniciDurum[chatId] = { adim: 'tamamla_secim', isler };
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tekraredenler/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await tekrarEdenIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '🔁 <b>TEKRAR EDEN İŞLER</b>\n━━━━━━━━━━━━━━━\n\nHenüz tekrar eden iş yok.\n/tekraredenekle ile ekleyebilirsiniz.');
      return;
    }
    let metin = `🔁 <b>TEKRAR EDEN İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
      const tip = notionMetinAl(is.properties['TEKRAR_TİPİ']);
      const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
      const saat = notionMetinAl(is.properties['TEKRAR_SAATİ']);
      const sonTetikleme = notionMetinAl(is.properties['SON_TETIKLEME']);
      const gunBilgi = gun !== '-' && gun !== 'Her Gün' ? ` — ${gun}` : '';
      metin += `${oncelikEmoji(oncelik)} <b>${baslik}</b>\n🔁 ${tip}${gunBilgi} ${saat}\n⏱ Son: ${sonTetikleme}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tekraredenekle/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'tekrar_isim' };
  await mesajGonder(chatId, '🔁 <b>TEKRAR EDEN İŞ EKLEME</b>\n━━━━━━━━━━━━━━━\n\n<b>1/5 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)');
});

bot.onText(/\/shift (.+)/, async (msg, match) => {
  await shiftKaydet(match[1], msg.chat.id);
});

bot.onText(/\/yeni/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'isim' };
  await mesajGonder(chatId, '🆕 <b>YENİ İŞ AÇILIYOR</b>\n━━━━━━━━━━━━━━━\n\n<b>1/5 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)');
});

bot.onText(/\/iptal/, async (msg) => {
  delete kullaniciDurum[msg.chat.id];
  await mesajGonder(msg.chat.id, '❌ İşlem iptal edildi.', { remove_keyboard: true });
});

bot.onText(/\/ai/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'ai_sohbet', mesajlar: [] };
  await mesajGonder(chatId, '🤖 <b>AI Asistan aktif</b>\n━━━━━━━━━━━━━━━\n\nMerhaba! İşler, shiftler veya aklına takılan herhangi bir şey hakkında konuşabiliriz.\n\nÇıkmak için /iptal yaz.');
});

bot.onText(/\/yardim|\/start/, async (msg) => {
  const metin = `🤖 <b>KOMUT LİSTESİ</b>\n━━━━━━━━━━━━━━━\n\n📋 <b>İş Listeleme</b>\n/acik — Tüm açık işler\n/kritik — Kritik işler\n/yüksek — Yüksek öncelikli işler\n/normal — Normal işler\n/biten — Bugün biten işler\n/biten 23.05.2026 — O güne ait bitenler\n\n✅ <b>İş Yönetimi</b>\n/yeni — Yeni iş aç\n/tamamla — İş tamamla\n/arsivle — Biten işleri arşivle\n\n🔁 <b>Tekrar Eden İşler</b>\n/tekraredenler — Tekrar eden işleri listele\n/tekraredenekle — Tekrar eden iş ekle\n\n👥 <b>Shift</b>\n/shift [bilgi] — Haftalık shift kaydet\n\n🤖 <b>AI Asistan</b>\n/ai — Yapay zeka ile konuş\n\n❌ /iptal — İşlemi iptal et`;
  await mesajGonder(msg.chat.id, metin);
});

// =========================================
//   KONUŞMA AKIŞI
// =========================================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const metin = msg.text || '';
  if (metin.startsWith('/')) return;
  const durum = kullaniciDurum[chatId];
  if (!durum) return;

  if (durum.adim === 'ai_sohbet') {
    try {
      await bot.sendChatAction(chatId, 'typing');
      const cevap = await geminiCevapAl(chatId, metin);
      await mesajGonder(chatId, cevap);
    } catch (e) {
      await mesajGonder(chatId, '❌ AI hatası: ' + e.message);
    }
    return;
  }

  if (durum.adim?.startsWith('tekrar_')) {
    await tekrarEdenIsEkle(chatId, durum, metin);
    return;
  }

  if (durum.adim === 'isim') {
    durum.isAdi = metin; durum.adim = 'oncelik';
    await mesajGonder(chatId, `✅ İş adı: <b>${metin}</b>\n\n<b>2/5 — Öncelik?</b>`, {
      keyboard: [[{ text: '🔴 KRİTİK' }, { text: '🟡 YÜKSEK' }], [{ text: '🟢 NORMAL' }, { text: '🔵 BEKLEMEDE' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'oncelik') {
    durum.oncelik = metin.replace('🔴 ', '').replace('🟡 ', '').replace('🟢 ', '').replace('🔵 ', '');
    durum.adim = 'sorumlu';
    await mesajGonder(chatId, `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/5 — Sorumlu?</b>`, { remove_keyboard: true });
  } else if (durum.adim === 'sorumlu') {
    durum.sorumlu = metin; durum.adim = 'deadline';
    await mesajGonder(chatId, `✅ Sorumlu: <b>${metin}</b>\n\n<b>4/5 — Deadline?</b>\n\nFormat: 28.05.2026 14:00\nYoksa <b>yok</b> yaz`);
  } else if (durum.adim === 'deadline') {
    durum.deadline = metin; durum.adim = 'altmaddeler';
    await mesajGonder(chatId, `✅ Deadline: <b>${metin}</b>\n\n<b>5/5 — Alt maddeler?</b>\n\nVirgülle yaz veya <b>yok</b> yaz`);
  } else if (durum.adim === 'altmaddeler') {
    durum.altMaddeler = metin;
    delete kullaniciDurum[chatId];
    try {
      await yeniIsOlustur(durum.isAdi, durum.oncelik, durum.sorumlu, durum.deadline, durum.altMaddeler);
      const deadlineMetin = durum.deadline.toLowerCase() === 'yok' ? 'Deadline yok' : durum.deadline;
      const altMaddeMetin = durum.altMaddeler.toLowerCase() === 'yok' ? '' : `\n📝 ${durum.altMaddeler.split(',').length} alt madde`;
      await bot.sendMessage(CHAT_ID, `🆕 <b>YENİ İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(durum.oncelik)} <b>${durum.isAdi}</b>\n👤 ${durum.sorumlu}\n⏰ ${deadlineMetin}${altMaddeMetin}`, { parse_mode: 'HTML' });
      if (String(chatId) !== String(CHAT_ID)) await mesajGonder(chatId, '✅ İş başarıyla açıldı!');
    } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
  } else if (durum.adim === 'tamamla_secim') {
    const secim = parseInt(metin) - 1;
    if (isNaN(secim) || secim < 0 || secim >= durum.isler.length) { await mesajGonder(chatId, '❌ Geçersiz numara.'); return; }
    const secilenIs = durum.isler[secim];
    const baslik = notionMetinAl(secilenIs.properties['İş Başlığı']);
    const maddeler = altMaddeleriParse(notionMetinAl(secilenIs.properties['NOTLAR']));
    if (maddeler.length === 0) {
      delete kullaniciDurum[chatId];
      await isGuncelle(secilenIs.id, { 'DURUM': { select: { name: 'BİTTİ' } } });
      await bitenIsBildirimiGonder(secilenIs.id);
      return;
    }
    let maddeMetin = `📋 <b>${baslik}</b>\n━━━━━━━━━━━━━━━\n\n`;
    maddeler.forEach((m, i) => { maddeMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`; });
    maddeMetin += '\nNumaraları yaz (örn: <b>1 3</b>) | <b>hepsi</b> | <b>bitir</b>';
    kullaniciDurum[chatId] = { adim: 'tamamla_maddeler', secilenIs, baslik, maddeler };
    await mesajGonder(chatId, maddeMetin);
  } else if (durum.adim === 'tamamla_maddeler') {
    const { secilenIs, baslik, maddeler } = durum;
    if (metin.toLowerCase() === 'bitir') {
      delete kullaniciDurum[chatId];
      await isGuncelle(secilenIs.id, { 'DURUM': { select: { name: 'BİTTİ' } } });
      await bitenIsBildirimiGonder(secilenIs.id);
      return;
    }
    if (metin.toLowerCase() === 'hepsi') {
      maddeler.forEach(m => m.tamamlandi = true);
    } else {
      metin.split(/[\s,]+/).map(n => parseInt(n) - 1).filter(n => !isNaN(n) && n >= 0 && n < maddeler.length).forEach(n => maddeler[n].tamamlandi = true);
    }
    const yeniNotlar = altMaddeleriYaz(maddeler);
    const hepsiTamam = maddeler.every(m => m.tamamlandi);
    const updateProps = { 'NOTLAR': { rich_text: [{ text: { content: yeniNotlar } }] } };
    if (hepsiTamam) updateProps['DURUM'] = { select: { name: 'BİTTİ' } };
    await isGuncelle(secilenIs.id, updateProps);
    delete kullaniciDurum[chatId];
    if (hepsiTamam) {
      await bitenIsBildirimiGonder(secilenIs.id);
    } else {
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      let duzenliMetin = `📋 <b>${baslik}</b> güncellendi\n━━━━━━━━━━━━━━━\n\n`;
      maddeler.forEach((m, i) => { duzenliMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`; });
      duzenliMetin += `\n${tamamlanan}/${maddeler.length} madde tamamlandı.`;
      await mesajGonder(chatId, duzenliMetin);
    }
  }
});

setInterval(kritikIsleriiBildir, 30 * 60 * 1000);
setInterval(yuksekIsleriiBildir, 45 * 60 * 1000);
setInterval(tekrarEdenIsleriKontrolEt, 60 * 1000);

console.log('🤖 İşler Botu başlatıldı!');
