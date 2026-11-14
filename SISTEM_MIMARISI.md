# Mars Space Vision — Sistem Mimarisi

**Teslim kapsamı:** NASA Space Apps Challenge 2026, Interplanetary Survival Guide: Martian Map. Tek geliştiricili Gale Krateri MVP’si. Çalışma kopyası `Mert3ren/Mars-Space-Vision`.

## 1. Görev ve kullanıcı akışı

Astronot, Bradbury Landing yakınındaki temsili üsten Yellowknife Bay’e gidip bilim çalışması yaptıktan sonra üsse dönmeyi planlar. Panelde optik, eğim ve termal katmanları açabilir, haritada iki noktayı değiştirebilir ve gidiş/dönüş yükseklik profilini inceleyebilir. Bilim durağında üç maddelik bir saha kontrol listesi vardır. Durak süresi veya gecikme değiştiğinde dönüş marjı, batarya ve oksijen aynı anda güncellenir.

Varsayılan senaryoda üretim verisiyle hesaplanan gidiş-dönüş **934 m**, süre **43 dk**, rezerv marjı **+27 dk**. `Simulate 40 min delay` ile görev **83 dk** sürer, batarya yaklaşık **%15** ile **%20** rezerv eşiğinin altına iner ve marj **−13 dk** olur. Bu değerler kaynak simülasyonuna aittir.

## 2. Mimari

- React, TypeScript, Vite ve Leaflet ile tek statik web uygulaması. Eğimin görsel katmanı ve kaynak simülasyonu tarayıcıda üretilir.
- `public/gale/terrain.json`, yerel çalışma alanını, grid değerlerini, referans noktalarını ve veri kaynağı manifestini taşır. Görüntüler aynı statik dizinde WebP olarak sunulur.
- Python 3.11, Rasterio, NumPy ve Pillow ile veri hazırlama işlemi `scripts/prepare_gale.py` içinde tekrarlanabilir. Uygulama çalışırken NASA servisine, ağ bağlantısına, ayrı API’ye veya veritabanına ihtiyaç duymaz. İnternetsiz kullanım için dosyalar yerel HTTP sunucusundan açılır.
- Harita tam krater, iniş bölgesi ve EVA yürüyüş alanını hem 2B hem 3B gösterir. 3B görünüm WebGL 2 ile açılır ve yalnızca seçildiğinde yüklenir. Krater ve iniş bölgesi USGS MOLA–HRSC yüksekliklerini, yürüyüş alanı 10 m Gale gridini kullanır. Dikey abartı ekranda gösterilir ve rota hesabına uygulanmaz.

## 3. Veri kaynakları ve yarışma bağlantısı

NASA JPL **Mars Trek**, challenge’ın Resources listesinde yer alan ve uygulamada kullanılan kaynaktır. Topoğrafya, optik ve termal veriler aynı 1 km² pencerede bir araya gelir. Panelde **Data sources** menüsü her katmanın ürününü, kredisini ve orijinal veri bağlantısını gösterir. [Challenge kaynaklarının yerel organizatör kopyası](https://hackathlone.com/challenges/interplanetary-survival-guide-martian-map#resources)

| Ürün | Uygulamadaki kullanım |
|---|---|
| USGS Gale Merged DEM v3 | Ürün piksel aralığı 1 m, uygulama örnek aralığı 10 m. Eğim, A* ve yükseklik profili. Birleşik ürün farklı çözünürlüklü girdiler içerir. [Katalog](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m) |
| USGS MOLA–HRSC 200 m DEM | 3B görünüm için tam krater 220 × 220, iniş bölgesi 41 × 41 olarak paketlenir. [Katalog](https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m) |
| Gale HiRISE optik mozaik | Aynı alandan 1 m web görüntüsü, orijinal örnek aralığı 25 cm. Haritanın optik tabanı. [Katalog](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_orthophoto_mosaic_25cm) |
| **Mars Trek / Mars Odyssey THEMIS gündüz IR** | Yaklaşık 100 m kaynak aralıklı arşiv görüntüsünün kırpımı. Renkler yerel kontrastı artırılmış göreli kızılötesi parlaklıktır. Sıcaklık ölçümü ya da A* girdisi olarak kullanılmaz. [Karo](https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm/9/269/902.png) |
| Curiosity konum kayıtları ve Mastcam | Sol 3 ve Sol 130 konumları görev işaretleriyle eşleşir. Bilim kartında Sol 139 PIA16706 görüntüsü kullanılır. [Konum arşivi](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) · [Mastcam](https://science.nasa.gov/photojournal/spherules-in-yellowknife-bay/) |

Çalışma alanının Mars equirectangular metre sınırları batı 8.146.500, doğu 8.147.500, güney −272.550, kuzey −271.550. Mars küre yarıçapı 3.396.190 m. Harita koordinatları kuzey yukarı ve grid kuzeybatıdan güneydoğuya satır sıralı. Kullanıcıya planetosentrik enlem ve doğu-pozitif boylam gösterilir. Örnek 10.000 yükseklik hücresi, 100 × 100 grid.

## 4. Hesaplama sözleşmesi

**Rota.** 8-komşulu A* araması. Karşılıklı adım maliyeti `yatay metre × (1 + 3 × (adım eğimi / 18°)²)`. Yatay düz mesafe sezgiseldir. Merkezi farklarla hesaplanan hücre eğimi ve komşular arası adım eğimi için 18° demo eşiği geçerlidir. Eksik hücreler ve eğimi belirsiz sınır hücreleri kapalıdır. İki bitişik hücre de geçilir durumdaysa çapraz geçiş yapılabilir. Simetrik modelde dönüş rotası gidişin tersidir. Alan dışı, geçilemeyen hücre, aynı hücre ve bağlantısız rota durumları ayrı ayrı ele alınır.

**Kaynaklar.** Başlangıç kapasitesi oksijen ve batarya için %48. Oksijen saatte 18, batarya 24 yüzde puanı tüketir, rezerv eşiği %20. Yürüme hızı 2 km/sa ve varsayılan bilim durağı 15 dk. Görev süresi gidiş, dönüş, durak ve gecikmenin toplamıdır. Rezerv marjı, iki kaynağın en kısıtlayıcı olanının eşik süresinden görev süresinin çıkarılmasıyla bulunur. Eğitim amaçlı prototip. Küçük engeller, zemine tutunma ve gerçek yaşam destek koşulları modele dahil değildir.

## 5. Doğrulama, demo ve teslim

- `npm test` düz grid mesafesi, geçersiz hücre, köşeden geçiş yasağı, dik geçiş ve gerçek Gale rotasında gecikmeyi doğrular. `npm run build` TypeScript kontrolü ve statik üretim derlemesidir.
- Jüri demosu 0–5 sn Gale görevi, 5–12 sn optik/eğim ve **Mars Trek** termal katmanı, 12–20 sn bilim durağı ve +27 dk, 20–26 sn 40 dk gecikmeyle −13 dk, 26–30 sn gecikmeyi kaldır. İngilizce anlatımda veri kaynaklarını harita üzerinde göster.
- Teslim alanlarına çalışan demo, kaynakların ürün içindeki rolü, repo, varsa lisans seçimi ve doğru AI kullanım beyanı eklenir. Codex, mimari planlama ve uygulama geliştirmeye katkı sağladı. Uygulama çalışma anında bir AI servisi çağırmaz. [2026 katılımcı koşulları](https://www.spaceappschallenge.org/legal/) · [Kaynak ve demo açıklaması](https://github.com/nasa/spaceapps/discussions/1947)
- Tek katılımcı, yerel etkinlik. Genel portal kapanışı 15 Kasım 2026 yerel saatle 23.59. Daha erken yerel jüri veya teslim saati için yerel organizatör takvimi esas alınır. [2026 etkinlik takvimi](https://www.spaceappschallenge.org/2026/)
