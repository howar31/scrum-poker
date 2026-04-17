# Scrum Poker

A Serverless P2P Scrum Poker web application built with React, Vite, TailwindCSS, and PeerJS.
This application allows teams to estimate stories without requiring a backend server or database.

## Features
- **Serverless & P2P**: Uses WebRTC (via PeerJS) for real-time communication between browsers.
- **Host Migration**: If the room host disconnects, the next oldest peer is automatically promoted to host.
- **Modern UI & Animations**: Smooth animations using Framer Motion, with a "Reduce Motion" toggle for performance.
- **Theming**: Supports Dark and Light modes.
- **Responsive**: Fully responsive design (RWD) for mobile and desktop.

## Development

### Install Dependencies
```bash
npm install
```

### Start Local Server
```bash
npm run dev
```

### Build for Production
```bash
npm run build
```

## Deployment
This project is configured to automatically deploy to GitHub Pages when changes are pushed to the `main` branch, via GitHub Actions (`.github/workflows/deploy.yml`).
