# Swoogo Capture – Registrant Evidence Collector

This project automates capturing **registrant evidence** from Swoogo:

- Attendance Status / Proof  
- Contact Details  
- Ticket & Email Delivery (full email iframe)  
- QR Code Ticket Email  
- Confirmation Page  
- Invoice Page  

Each registrant’s evidence is collected into its own folder, zipped, and uploaded to **Azure Blob Storage**.  
The local directory is then deleted (to save disk space).

---

## ✨ Features
- Automates login with a saved Playwright session (`auth.json`)
- Waits until spinners are gone before capturing pages
- Captures email previews by expanding the iframe to full height
- Removes left navigation panel for clean screenshots
- Creates one ZIP per registrant and uploads it to Azure Blob Storage

---

## 📦 Requirements
- [Node.js](https://nodejs.org/) 18+
- [Git](https://git-scm.com/)
- A Swoogo account with access to registrants
- An Azure Storage account & container

---

## 🔧 Setup

Clone the repo:
```bash
npm install
npx playwright install chromium
export AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=...;AccountName=youracct;AccountKey=xxxx;EndpointSuffix=core.windows.net"
export AZURE_BLOB_CONTAINER="swoogo-evidence"
#Step 1: Save your Swoogo session (first time only)
node swoogo_capture.js --save-session --auth auth.json
#Step 2:
Update the registration.csv to contain the list of registrations you want to capture.
#Step 3: Run the capture
node capture.js --in registration.csv --auth auth.json --out out --eventId 255274

