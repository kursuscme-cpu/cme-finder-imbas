# Pengimbas Facebook untuk CME Finder

Membaca Facebook Page awam dengan pelayar sebenar dan menghantar teks siarannya
ke aplikasi CME Finder, yang memutuskan sama ada ia acara CME dan memberitahu
penggunanya.

## Kenapa repositori ini berasingan, dan awam

Membaca Facebook Page memerlukan pelayar sebenar — permintaan HTTP biasa hanya
mendapat dinding log masuk, di mana sahaja ia dijalankan. GitHub Actions ialah
satu-satunya tempat percuma yang sudi menjalankan pelayar mengikut jadual.

Repositori privat mendapat 2,000 minit sebulan. Pada kadar yang diperlukan
untuk menangkap hebahan CME yang diumumkan pada pagi yang sama, itu jauh tidak
mencukupi. Repositori awam mendapat minit tanpa had. Jadi pengimbas duduk di
sini seorang diri, dan aplikasi yang ia suapkan kekal privat.

Tiada apa di sini yang sensitif. Dua nilai yang diperlukan disimpan sebagai
repository secret, dan senarai Page diambil daripada aplikasi semasa larian.

## Adab

- Hanya Page awam, tanpa log masuk, tanpa akaun Facebook sesiapa terlibat.
- Hanya teks siaran yang dihantar, dan hanya kepada aplikasi yang memilikinya.
- Satu lawatan per Page per larian.

## Menjalankannya

```
CME_FINDER_URL=https://contoh.vercel.app INGEST_SECRET=... node scan-fb.mjs
```

`FB_PAGES` (dipisah koma) memintas senarai daripada aplikasi.
`FB_PAGES_PER_RUN` menetapkan lebar tetingkap; `FB_RUN_EVERY_MS` mesti sepadan
dengan jadual workflow, jika tidak tetingkap yang sama berulang sementara yang
lain dilangkau.
