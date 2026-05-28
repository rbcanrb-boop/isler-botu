const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('@notionhq/client');

const TOKEN = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const ARSIV_DATABASE_ID = process.env.ARSIV_DATABASE_ID;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });
const notion = new Client({ auth: NOTION_TOKEN });

const kullaniciDurum = {};

// =========================================
//   YARDIMCI FONKSİYONLAR
// =========================================

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

// =========================================
//   NOTION FONKSİYONLARI
// =========================================

async function acikIsleriGetir() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: 'DURUM', select: { equals: 'AÇIK' } }
  });
  return response.results;
}

async function bitenIsleriGetir() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: 'DURUM', select: { equals: 'BİTTİ' } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
  });
  return response.results;
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
        const isoTarih = `${parcalar[3]}-${parcalar[2].padStart(2,'0')}-${parcalar[1].padStart(2,'0')}T${parcalar[4].padStart(2,'0')}:${parcalar[5]}:00`;
        properties['Deanline'] = { date: { start: isoTarih } };
      }
    } catch (e) { console.log('Tarih parse hatası:', e); }
  }

  if (altMaddeler && altMaddeler.toLowerCase() !== 'yok') {
    const maddeler = altMaddeler.split(',').map(m => `☐ ${m.trim()}`).join('\n');
    properties['NOTLAR'] = { rich_text: [{ text: { content: maddeler } }] };
  }

  return await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties
  });
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

async function bitenIsleriKontrolEt() {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: 'DURUM', select: { equals: 'BİTTİ' } },
          { property: 'Bildirim Gönderildi', checkbox: { equals: false } }
        ]
      }
    });

    for (const is of response.results) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
      const metin = `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}\n\nTebrikler! 🎉`;
      await bot.sendMessage(CHAT_ID, metin, { parse_mode: 'HTML' });
      await notion.pages.update({
        page_id: is.id,
        properties: { 'Bildirim Gönderildi': { checkbox: true } }
      });
    }
  } catch (e) {
    console.log('Biten işler kontrol hatası:', e.message);
  }
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
      const notlar = notionMetinAl(is.properties['NOTLAR']);
      const maddeler = altMaddeleriParse(notlar);
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      const altMaddeBilgi = maddeler.length > 0 ? ` (${tamamlanan}/${maddeler.length})` : '';
      const isKarti = `${oncelikEmoji(oncelik)} <b>${baslik}</b>${altMaddeBilgi}\n👤 ${sorumlu}\n⏰ ${deadline}`;
      if (gruplar[oncelik]) gruplar[oncelik].push(isKarti);
      else gruplar['DİĞER'].push(isKarti);
    }

    const sira = [
      { key: 'KRİTİK', emoji: '🔴' },
      { key: 'YÜKSEK', emoji: '🟡' },
      { key: 'NORMAL', emoji: '🟢' },
      { key: 'BEKLEMEDE', emoji: '🔵' },
      { key: 'DİĞER', emoji: '⚪' }
    ];

    for (const grup of sira) {
      if (gruplar[grup.key].length > 0) {
        metin += `${grup.emoji} <b>${grup.key} (${gruplar[grup.key].length})</b>\n\n`;
        metin += gruplar[grup.key].join('\n\n') + '\n\n';
      }
    }

    await mesajGonder(chatId, metin.trim());
  } catch (e) {
    await mesajGonder(chatId, '❌ Hata: ' + e.message);
  }
});

bot.onText(/\/biten/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await bitenIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '✅ <b>BİTEN İŞLER</b>\n━━━━━━━━━━━━━━━\n\nHenüz biten iş yok.');
      return;
    }
    let metin = `✅ <b>BİTEN İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
      metin += `${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}\n\n`;
    }
    metin += `Arşivlemek için /arsivle yaz.`;
    await mesajGonder(chatId, metin.trim());
  } catch (e) {
    await mesajGonder(chatId, '❌ Hata: ' + e.message);
  }
});

bot.onText(/\/arsivle/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await bitenIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '🗂️ Arşivlenecek biten iş yok.');
      return;
    }
    await mesajGonder(chatId, `⏳ ${isler.length} iş arşivleniyor...`);
    let basarili = 0;
    for (const is of isler) {
      try { await isArsivle(is); basarili++; } catch (e) { console.error('Arşivleme hatası:', e.message); }
    }
    await bot.sendMessage(CHAT_ID, `🗂️ <b>${basarili} İŞ ARŞİVLENDİ</b>\n━━━━━━━━━━━━━━━\n\nİyi geceler ekip 😴`, { parse_mode: 'HTML' });
  } catch (e) {
    await mesajGonder(chatId, '❌ Hata: ' + e.message);
  }
});

bot.onText(/\/tamamla/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '📋 Açık iş yok.');
      return;
    }

    let metin = '📋 <b>Hangi işi tamamlıyorsunuz?</b>\n━━━━━━━━━━━━━━━\n\n';
    isler.forEach((is, i) => {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
      metin += `${i + 1}. ${oncelikEmoji(oncelik)} ${baslik}\n`;
    });
    metin += '\nNumara yaz (örn: 2)';

    kullaniciDurum[chatId] = { adim: 'tamamla_secim', isler };
    await mesajGonder(chatId, metin);
  } catch (e) {
    await mesajGonder(chatId, '❌ Hata: ' + e.message);
  }
});

bot.onText(/\/yeni/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'isim' };
  await mesajGonder(chatId, '🆕 <b>YENİ İŞ AÇILIYOR</b>\n━━━━━━━━━━━━━━━\n\n<b>1/5 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)');
});

bot.onText(/\/iptal/, async (msg) => {
  const chatId = msg.chat.id;
  delete kullaniciDurum[chatId];
  await mesajGonder(chatId, '❌ İşlem iptal edildi.');
});

bot.onText(/\/yardim|\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const metin = `🤖 <b>KOMUT LİSTESİ</b>\n━━━━━━━━━━━━━━━\n\n/acik — Açık işleri listeler\n/biten — Biten işleri listeler\n/tamamla — İş tamamlama akışı\n/arsivle — Biten işleri arşive taşır\n/yeni — Yeni iş açar\n/iptal — İşlemi iptal eder\n/yardim — Bu menüyü gösterir`;
  await mesajGonder(chatId, metin);
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

  // --- YENİ İŞ AKIŞI ---
  if (durum.adim === 'isim') {
    durum.isAdi = metin;
    durum.adim = 'oncelik';
    await mesajGonder(chatId,
      `✅ İş adı: <b>${metin}</b>\n\n<b>2/5 — Öncelik nedir?</b>`,
      {
        keyboard: [
          [{ text: '🔴 KRİTİK' }, { text: '🟡 YÜKSEK' }],
          [{ text: '🟢 NORMAL' }, { text: '🔵 BEKLEMEDE' }]
        ],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    );
  } else if (durum.adim === 'oncelik') {
    durum.oncelik = metin.replace('🔴 ', '').replace('🟡 ', '').replace('🟢 ', '').replace('🔵 ', '');
    durum.adim = 'sorumlu';
    await mesajGonder(chatId, `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/5 — Sorumlu kim?</b>`, { remove_keyboard: true });

  } else if (durum.adim === 'sorumlu') {
    durum.sorumlu = metin;
    durum.adim = 'deadline';
    await mesajGonder(chatId, `✅ Sorumlu: <b>${metin}</b>\n\n<b>4/5 — Deadline?</b>\n\nFormat: 28.05.2026 14:00\nYoksa <b>yok</b> yaz`);

  } else if (durum.adim === 'deadline') {
    durum.deadline = metin;
    durum.adim = 'altmaddeler';
    await mesajGonder(chatId, `✅ Deadline: <b>${metin}</b>\n\n<b>5/5 — Alt maddeler?</b>\n\nVirgülle yaz: <i>Görsel hazırlandı mı, Yayına alındı mı, Bildirim gönderildi mi</i>\nYoksa <b>yok</b> yaz`);

  } else if (durum.adim === 'altmaddeler') {
    durum.altMaddeler = metin;
    delete kullaniciDurum[chatId];

    try {
      await yeniIsOlustur(durum.isAdi, durum.oncelik, durum.sorumlu, durum.deadline, durum.altMaddeler);
      const emoji = oncelikEmoji(durum.oncelik);
      const deadlineMetin = durum.deadline.toLowerCase() === 'yok' ? 'Deadline yok' : durum.deadline;
      const altMaddeMetin = durum.altMaddeler.toLowerCase() === 'yok' ? '' : `\n📝 ${durum.altMaddeler.split(',').length} alt madde`;
      const bildirim = `🆕 <b>YENİ İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${emoji} <b>${durum.isAdi}</b>\n👤 ${durum.sorumlu}\n⏰ ${deadlineMetin}${altMaddeMetin}`;
      await bot.sendMessage(CHAT_ID, bildirim, { parse_mode: 'HTML' });
      if (String(chatId) !== String(CHAT_ID)) {
        await mesajGonder(chatId, '✅ İş başarıyla açıldı!');
      }
    } catch (e) {
      console.error('İş oluşturma hatası:', e);
      await mesajGonder(chatId, '❌ Hata oluştu: ' + e.message);
    }

  // --- TAMAMLA AKIŞI ---
  } else if (durum.adim === 'tamamla_secim') {
    const secim = parseInt(metin) - 1;
    if (isNaN(secim) || secim < 0 || secim >= durum.isler.length) {
      await mesajGonder(chatId, '❌ Geçersiz numara, tekrar dene.');
      return;
    }

    const secilenIs = durum.isler[secim];
    const baslik = notionMetinAl(secilenIs.properties['İş Başlığı']);
    const notlar = notionMetinAl(secilenIs.properties['NOTLAR']);
    const maddeler = altMaddeleriParse(notlar);

    if (maddeler.length === 0) {
      // Alt madde yok, direkt bitir
      delete kullaniciDurum[chatId];
      await isGuncelle(secilenIs.id, { 'DURUM': { select: { name: 'BİTTİ' } } });
      const bildirim = `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n<b>${baslik}</b>\n\nTebrikler! 🎉`;
      await bot.sendMessage(CHAT_ID, bildirim, { parse_mode: 'HTML' });
      return;
    }

    let maddeMetin = `📋 <b>${baslik}</b>\n━━━━━━━━━━━━━━━\n\n`;
    maddeler.forEach((m, i) => {
      maddeMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`;
    });
    maddeMetin += '\nTamamlananların numaralarını yaz (örn: <b>1 3</b>)\nHepsini bitirmek için <b>hepsi</b> yaz\nİşi direkt bitirmek için <b>bitir</b> yaz';

    kullaniciDurum[chatId] = {
      adim: 'tamamla_maddeler',
      secilenIs,
      baslik,
      maddeler
    };
    await mesajGonder(chatId, maddeMetin);

  } else if (durum.adim === 'tamamla_maddeler') {
    const { secilenIs, baslik, maddeler } = durum;

    if (metin.toLowerCase() === 'bitir') {
      delete kullaniciDurum[chatId];
      await isGuncelle(secilenIs.id, { 'DURUM': { select: { name: 'BİTTİ' } } });
      await bot.sendMessage(CHAT_ID, `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n<b>${baslik}</b>\n\nTebrikler! 🎉`, { parse_mode: 'HTML' });
      return;
    }

    if (metin.toLowerCase() === 'hepsi') {
      maddeler.forEach(m => m.tamamlandi = true);
    } else {
      const numaralar = metin.split(/[\s,]+/).map(n => parseInt(n) - 1).filter(n => !isNaN(n) && n >= 0 && n < maddeler.length);
      numaralar.forEach(n => maddeler[n].tamamlandi = true);
    }

    const yeniNotlar = altMaddeleriYaz(maddeler);
    const hepsiTamam = maddeler.every(m => m.tamamlandi);

    const updateProps = {
      'NOTLAR': { rich_text: [{ text: { content: yeniNotlar } }] }
    };

    if (hepsiTamam) {
      updateProps['DURUM'] = { select: { name: 'BİTTİ' } };
    }

    await isGuncelle(secilenIs.id, updateProps);
    delete kullaniciDurum[chatId];

    if (hepsiTamam) {
      await bot.sendMessage(CHAT_ID, `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n<b>${baslik}</b>\n\nTüm maddeler tamamlandı! 🎉`, { parse_mode: 'HTML' });
    } else {
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      let duzenliMetin = `📋 <b>${baslik}</b> güncellendi\n━━━━━━━━━━━━━━━\n\n`;
      maddeler.forEach((m, i) => {
        duzenliMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`;
      });
      duzenliMetin += `\n${tamamlanan}/${maddeler.length} madde tamamlandı.`;
      await mesajGonder(chatId, duzenliMetin);
    }
  }
});

// =========================================
//   OTOMATİK KONTROLLER
// =========================================

setInterval(bitenIsleriKontrolEt, 5 * 60 * 1000);
bitenIsleriKontrolEt();

console.log('🤖 İşler Botu başlatıldı!');
