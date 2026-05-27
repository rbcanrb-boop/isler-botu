const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('@notionhq/client');

const TOKEN = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });
const notion = new Client({ auth: NOTION_TOKEN });

// Kullanıcı durumlarını hafızada tut
const kullaniciDurum = {};

// =========================================
//   YARDIMCI FONKSİYONLAR
// =========================================

function oncelikEmoji(oncelik) {
  if (!oncelik) return '⚪';
  const o = oncelik.toUpperCase();
  if (o === 'KRİTİK' || o === 'KRITIK') return '🔴';
  if (o === 'YÜKSEK' || o === 'YUKSEK') return '🟡';
  if (o === 'NORMAL') return '🟢';
  if (o === 'BEKLEMEDE') return '🔵';
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
  } catch (e) {
    return tarihStr;
  }
}

function notionMetinAl(prop) {
  if (!prop) return '-';
  if (prop.type === 'title' && prop.title) {
    return prop.title.map(t => t.plain_text).join('') || '-';
  }
  if (prop.type === 'rich_text' && prop.rich_text) {
    return prop.rich_text.map(t => t.plain_text).join('') || '-';
  }
  if (prop.type === 'select' && prop.select) {
    return prop.select.name || '-';
  }
  if (prop.type === 'date' && prop.date) {
    return tarihFormat(prop.date.start);
  }
  if (prop.type === 'checkbox') {
    return prop.checkbox ? 'Evet' : 'Hayır';
  }
  return '-';
}

async function mesajGonder(chatId, metin, klavye) {
  const opts = { parse_mode: 'HTML' };
  if (klavye) opts.reply_markup = klavye;
  await bot.sendMessage(chatId, metin, opts);
}

// =========================================
//   NOTION FONKSİYONLARI
// =========================================

async function acikIsleriGetir() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'DURUM',
      select: { equals: 'AÇIK' }
    }
  });
  return response.results;
}

async function yeniIsOlustur(isAdi, oncelik, sorumlu, deadline) {
  const properties = {
    'İş Başlığı': {
      title: [{ text: { content: isAdi } }]
    },
    'DURUM': {
      select: { name: 'AÇIK' }
    },
    'ÖNCELİK': {
      select: { name: oncelik.toUpperCase().replace('🔴 ', '').replace('🟡 ', '').replace('🟢 ', '').replace('🔵 ', '') }
    },
    'SORUMLU': {
      rich_text: [{ text: { content: sorumlu } }]
    }
  };

  if (deadline && deadline.toLowerCase() !== 'yok') {
    try {
      const parcalar = deadline.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (parcalar) {
        const isoTarih = `${parcalar[3]}-${parcalar[2].padStart(2,'0')}-${parcalar[1].padStart(2,'0')}T${parcalar[4].padStart(2,'0')}:${parcalar[5]}:00`;
        properties['Deanline'] = { date: { start: isoTarih } };
      }
    } catch (e) {
      console.log('Tarih parse hatası:', e);
    }
  }

  return await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties
  });
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

      // Bildirim gönderildi olarak işaretle
      await notion.pages.update({
        page_id: is.id,
        properties: {
          'Bildirim Gönderildi': { checkbox: true }
        }
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

    // Önceliğe göre grupla
    const gruplar = { 'KRİTİK': [], 'YÜKSEK': [], 'NORMAL': [], 'BEKLEMEDE': [], 'DİĞER': [] };

    for (const is of isler) {
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']).toUpperCase();
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);

      const isKarti = `${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}\n⏰ ${deadline}`;

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
    console.error('Açık işler hatası:', e);
    await mesajGonder(chatId, '❌ Hata: ' + e.message);
  }
});

bot.onText(/\/yeni/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'isim' };
  await mesajGonder(chatId,
    '🆕 <b>YENİ İŞ AÇILIYOR</b>\n━━━━━━━━━━━━━━━\n\n<b>1/4 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)'
  );
});

bot.onText(/\/iptal/, async (msg) => {
  const chatId = msg.chat.id;
  delete kullaniciDurum[chatId];
  await mesajGonder(chatId, '❌ İş açma iptal edildi.');
});

bot.onText(/\/yardim|\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const metin = `🤖 <b>KOMUT LİSTESİ</b>\n━━━━━━━━━━━━━━━\n\n/acik — Açık işleri listeler\n/yeni — Yeni iş açar\n/iptal — İşlemi iptal eder\n/yardim — Bu menüyü gösterir`;
  await mesajGonder(chatId, metin);
});

// =========================================
//   KONUŞMA AKIŞI
// =========================================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const metin = msg.text || '';

  // Komutları atla
  if (metin.startsWith('/')) return;

  const durum = kullaniciDurum[chatId];
  if (!durum) return;

  if (durum.adim === 'isim') {
    durum.isAdi = metin;
    durum.adim = 'oncelik';
    await mesajGonder(chatId,
      `✅ İş adı: <b>${metin}</b>\n\n<b>2/4 — Öncelik nedir?</b>`,
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
    await mesajGonder(chatId,
      `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/4 — Sorumlu kim?</b>`,
      { remove_keyboard: true }
    );
  } else if (durum.adim === 'sorumlu') {
    durum.sorumlu = metin;
    durum.adim = 'deadline';
    await mesajGonder(chatId,
      `✅ Sorumlu: <b>${metin}</b>\n\n<b>4/4 — Deadline?</b>\n\nFormat: 28.05.2026 14:00\nYoksa <b>yok</b> yaz`
    );
  } else if (durum.adim === 'deadline') {
    durum.deadline = metin;
    delete kullaniciDurum[chatId];

    try {
      await yeniIsOlustur(durum.isAdi, durum.oncelik, durum.sorumlu, durum.deadline);

      const emoji = oncelikEmoji(durum.oncelik);
      const deadlineMetin = durum.deadline.toLowerCase() === 'yok' ? 'Deadline yok' : durum.deadline;

      const bildirim = `🆕 <b>YENİ İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${emoji} <b>${durum.isAdi}</b>\n👤 ${durum.sorumlu}\n⏰ ${deadlineMetin}`;
      await bot.sendMessage(CHAT_ID, bildirim, { parse_mode: 'HTML' });

      if (String(chatId) !== String(CHAT_ID)) {
        await mesajGonder(chatId, '✅ İş başarıyla açıldı!');
      }
    } catch (e) {
      console.error('İş oluşturma hatası:', e);
      await mesajGonder(chatId, '❌ Hata oluştu: ' + e.message);
    }
  }
});

// =========================================
//   BİTEN İŞLERİ KONTROL (Her 5 dakika)
// =========================================

setInterval(bitenIsleriKontrolEt, 5 * 60 * 1000);
bitenIsleriKontrolEt(); // Başlangıçta bir kere çalıştır

console.log('🤖 İşler Botu başlatıldı!');
