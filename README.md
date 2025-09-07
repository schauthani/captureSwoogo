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
git clone https://github.com/yourname/swoogo-capture.git
cd swoogo-capture
