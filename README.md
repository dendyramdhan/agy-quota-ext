# ⚡ Antigravity Quota Manager

[![Version](https://img.shields.io/badge/version-3.3.0-blue.svg)](https://github.com/dendyramdhan/agy-quota-ext)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

An elegant, real-time AI quota monitor and multi-account manager extension for **Antigravity IDE**.

Track your **Gemini Models** and **Claude / GPT Models** rolling 5-hour limits, weekly cycle quotas, and exact reset timestamps with zero IDE session disruption.

---

## ✨ Features

- **👤 Account Dropdown (Quota Viewer)**:
  - Quickly switch between up to 6 saved Google accounts to inspect their quota meters.
  - **Non-disruptive**: Switching the dropdown **only changes what quota is displayed in the extension**. Your active Antigravity IDE coding session remains completely untouched.
- **📊 All Accounts Overview**:
  - Side-by-side visual cards displaying all saved accounts simultaneously.
  - Progress bars for Gemini (5-Hour) and Claude & GPT (5-Hour) quotas at a single glance.
  - Click any account to instantly view its detailed circular gauge and reset countdown.
- **🕒 Exact Reset Timestamps & Countdowns**:
  - Live countdown timers (hours & minutes remaining until full refresh).
  - Exact reset timestamps formatted in local Indonesian Time (WIB) with full date, month, and year.
- **🟢 Dual Pool Architecture**:
  - **Gemini Models Pool** (Gemini 3.1 Pro, 3.8 Flash, 3.7 Flash, 3.6 Flash).
  - **Claude & GPT Models Pool** (Claude Opus 4.6, Claude Sonnet 4.6, GPT-OSS 120B).
- **💻 Accompanying CLI (`agy-ext`)**:
  - Terminal-based real-time quota inspection and account management.

---

## 📸 Preview

- **Account Dropdown & Live Sync Status**: Displays whether the viewed account is active in the IDE or in monitoring mode.
- **Exhausted Limit Warning**: Clean circular gauges and alerts when third-party model limits are reached (0%).

---

## 🚀 Installation

### Option 1: Install VSIX Package
1. Download or package the `.vsix` bundle:
   ```bash
   npx @vscode/vsce package
   ```
2. Install into Antigravity IDE:
   ```bash
   antigravity-ide --install-extension agy-quota-manager-3.3.0.vsix --force
   ```
3. In Antigravity IDE, press `Cmd + Shift + P` and run **Developer: Reload Window**.

---

## 🛠️ CLI Helper (`agy-ext`)

An included CLI utility provides instant access from your terminal:

```bash
# View active account quota and live countdowns
agy-ext status

# View all saved accounts side-by-side
agy-ext all

# Add a secondary account to track
agy-ext add <email> [plan]

# Remove a secondary account
agy-ext remove <email>
```

---

## 📄 License

MIT
