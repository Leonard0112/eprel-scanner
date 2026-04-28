# EPREL Tyre Scanner — PWA Mobile

App web installabile su iPhone e Android per scansionare l'EAN e il QR code dell'etichetta UE di un pneumatico, salvare ogni articolo in modo progressivo, ed esportare un CSV compatibile con il tool desktop EPREL Matcher.

## Funzionalità

- 📷 Scansione **EAN** (barcode lineare) e **QR EPREL** con la fotocamera del telefono
- 👁 Preview live opzionale con dati EPREL (Marca, Modello, Misura, Codice velocità, Energia, Bagnato, Rumore) — richiede una API Key EPREL valida
- 🔢 Quantità + DOT (con avviso automatico se il DOT è più vecchio di 2 anni) + Note
- 💾 **Salvataggio progressivo** in localStorage + backup ridondante in IndexedDB ogni 10 articoli
- 🔄 Resume automatico della sessione alla riapertura
- 📤 Export CSV (con BOM per Excel) condivisibile via Web Share API o download diretto
- 📱 Installabile come app nella home screen (PWA)
- 🌐 Funziona su iOS Safari ≥14, Android Chrome, desktop Chrome/Firefox

## Struttura file

```
mobile/
├── index.html              # UI principale
├── app.js                  # Logica applicativa
├── styles.css              # Stile mobile-first
├── manifest.webmanifest    # Manifest PWA
├── service-worker.js       # Cache offline
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md               # Questo file
```

Nessuna dipendenza npm: l'unica libreria esterna (`html5-qrcode`) viene caricata via CDN.

## Test in locale

> ⚠️ La fotocamera richiede HTTPS o `localhost`. Su `localhost` funziona senza certificato.

```bash
cd mobile
python3 -m http.server 8000
```

Apri http://localhost:8000 nel browser. Su desktop la UI funziona ma serve un telefono per la fotocamera.

Per testare la fotocamera dal telefono in rete locale serve HTTPS (es. usando `mkcert` + un proxy HTTPS, o pubblicando la PWA online).

## Deploy gratuito (consigliato: GitHub Pages)

1. Crea un repo GitHub vuoto, es. `eprel-scanner`
2. Copia il contenuto di `mobile/` nella root del repo
3. `git add . && git commit -m "Initial PWA" && git push`
4. Vai su Settings → Pages → Source: `main` → root → Save
5. Dopo ~1 minuto l'URL `https://<tuo-utente>.github.io/eprel-scanner/` è online (HTTPS auto)

## Installazione su telefono

**iPhone (Safari):**
1. Apri l'URL in Safari (NON Chrome — solo Safari supporta "Aggiungi a Home")
2. Tocca il pulsante Condividi (quadrato con freccia)
3. Scorri e scegli **"Aggiungi alla schermata Home"**
4. Conferma → l'icona appare come una vera app

**Android (Chrome):**
1. Apri l'URL in Chrome
2. Menu (3 puntini) → **"Installa app"** o "Aggiungi a schermata home"
3. L'icona appare nel launcher

## Workflow quotidiano

1. Apri l'icona della PWA dalla home del telefono
2. (Solo prima volta) Tocca **⚙** → incolla l'API Key EPREL → **Test connessione** per abilitare la preview
3. Tocca **+ Nuovo pneumatico**
4. Tocca 📷 sul campo EAN → scansiona il barcode dell'adesivo Tyre24/distributore
5. Tocca 📷 sul campo EPREL → scansiona il QR code dell'etichetta UE
6. Se hai impostato l'API key: appare la preview con Marca, Modello, Misura, Codice velocità, classi etichetta — verifica visivamente
7. Imposta **Quantità** e **DOT** se rilevanti
8. Tocca **Aggiungi a lista**
9. Ripeti per ogni gomma. La lista è sempre persistita.
10. A fine sessione: tocca **Esporta CSV** sulla home → scegli destinazione (AirDrop/email/iCloud)
11. Sul Mac/PC apri il CSV col tool desktop `eprel_matcher.py` per popolare il template Tyre24

## Impostazioni (icona ⚙)

- **API Key EPREL** — facoltativa. Senza, la scansione funziona ma niente preview.
- **Test connessione** — verifica che la chiave sia valida.
- **Cancella sessione** — elimina tutti gli articoli scansionati (l'API key resta).

## Privacy & sicurezza

- Tutti i dati restano sul tuo dispositivo (localStorage + IndexedDB)
- L'API Key viene salvata in chiaro nel browser (come fa qualsiasi PWA con auth)
- Nessun tracker, nessun analytics, nessun server intermedio
- Le chiamate EPREL per la preview vanno direttamente da browser→`eprel.ec.europa.eu`

## Limitazioni note

- iOS Safari può svuotare i dati di siti non aperti per >7 giorni. La PWA installata "Add to Home" è esente, ma il backup IDB ogni 10 articoli aggiunge ulteriore resilienza.
- Lo scanner richiede buona illuminazione e fuoco a 10-15 cm dal codice
- L'API EPREL ha limite 5 req/sec; la preview cache evita chiamate ripetute sullo stesso ID
