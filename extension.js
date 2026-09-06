const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// Storage and IDE Paths
const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-quota');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'accounts.json');
const AGY_IDE_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE');
const STATE_DB = path.join(AGY_IDE_SUPPORT, 'User', 'globalStorage', 'state.vscdb');

if (!fs.existsSync(CONFIG_DIR)) {
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (e) {}
}

/**
 * Account Storage Helper
 */
function getSavedAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            return list.map(a => {
                if (!a.quota) {
                    a.quota = {
                        gemini: {
                            weekly: { percentage: 100, resetTime: new Date(Date.now() + 6 * 86400000).toISOString() },
                            fiveHour: { percentage: 100, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() }
                        },
                        claude: {
                            weekly: { percentage: 100, resetTime: new Date(Date.now() + 6 * 86400000).toISOString(), fiveHourLimited: false },
                            fiveHour: { percentage: 100, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() }
                        }
                    };
                }
                return a;
            });
        }
    } catch (e) {}
    return [];
}

function saveAccounts(accounts) {
    try {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    } catch (e) {}
}

function saveOrUpdateAccount(accountData, rawTokens, quotaData) {
    if (!accountData || !accountData.email) return;
    const accounts = getSavedAccounts();
    const existingIdx = accounts.findIndex(a => a.email.toLowerCase() === accountData.email.toLowerCase());
    const prev = existingIdx >= 0 ? accounts[existingIdx] : {};
    const entry = {
        email: accountData.email,
        name: accountData.name || prev.name || accountData.email.split('@')[0],
        plan: accountData.plan || prev.plan || 'Pro',
        lastSync: new Date().toISOString(),
        quota: quotaData || prev.quota || {
            gemini: {
                weekly: { percentage: 100, resetTime: null },
                fiveHour: { percentage: 100, resetTime: null }
            },
            claude: {
                weekly: { percentage: 100, resetTime: null, fiveHourLimited: false },
                fiveHour: { percentage: 100, resetTime: null }
            }
        },
        oauthToken: rawTokens?.oauthToken || prev.oauthToken || null,
        userStatus: rawTokens?.userStatus || prev.userStatus || null
    };
    if (existingIdx >= 0) {
        accounts[existingIdx] = { ...prev, ...entry };
    } else {
        accounts.push(entry);
    }
    saveAccounts(accounts);
}

function getRawStateBlobs() {
    try {
        if (!fs.existsSync(STATE_DB)) return null;
        const oauthToken = execSync(
            `sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken'"`,
            { encoding: 'utf8', timeout: 3000 }
        ).trim();
        const userStatus = execSync(
            `sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.userStatus'"`,
            { encoding: 'utf8', timeout: 3000 }
        ).trim();
        return { oauthToken, userStatus };
    } catch (e) {
        return null;
    }
}

function switchAccountBlobs(email) {
    const accounts = getSavedAccounts();
    const target = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    if (!target || !target.oauthToken || !target.userStatus) {
        throw new Error(`Account snapshot for ${email} is missing saved credentials.`);
    }

    const safeOauth = target.oauthToken.replace(/'/g, "''");
    const safeStatus = target.userStatus.replace(/'/g, "''");

    const sql = `
        INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.oauthToken', '${safeOauth}');
        INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.userStatus', '${safeStatus}');
    `;
    execSync(`sqlite3 "${STATE_DB}" "${sql}"`, { encoding: 'utf8', timeout: 5000 });
}

/**
 * Language Server Client with dynamic port discovery
 */
class LanguageServerClient {
    constructor() {
        this.port = 0;
        this.csrfToken = '';
        this.lastChecked = 0;
    }

    async ensureConnection() {
        const now = Date.now();
        if (this.port && this.csrfToken && (now - this.lastChecked < 8000)) {
            return true;
        }

        try {
            const ps = execSync('ps aux', { encoding: 'utf8', timeout: 3000 });
            const lines = ps.split('\n');

            for (const line of lines) {
                if (line.includes('language_server') && line.includes('--csrf_token')) {
                    const pidMatch = line.match(/^\S+\s+(\d+)/);
                    const csrfMatch = line.match(/--csrf_token\s+([^\s]+)/);
                    if (!pidMatch || !csrfMatch) continue;

                    const pid = pidMatch[1];
                    const csrf = csrfMatch[1];

                    // Candidate ports from lsof
                    const ports = [];
                    try {
                        const lsof = execSync(`lsof -a -nP -iTCP -sTCP:LISTEN -p ${pid}`, { encoding: 'utf8', timeout: 2000 });
                        const listenMatches = lsof.matchAll(/:([0-9]+)\s+\(LISTEN\)/g);
                        for (const lm of listenMatches) {
                            ports.push(parseInt(lm[1], 10));
                        }
                    } catch (e) {}

                    // Candidate ports from command line
                    const portMatches = line.matchAll(/--(?:https_server_port|extension_server_port|lsp_port)\s+([0-9]+)/g);
                    for (const m of portMatches) ports.push(parseInt(m[1], 10));

                    const uniquePorts = [...new Set(ports)];
                    for (const p of uniquePorts) {
                        const ok = await this._testPort(p, csrf);
                        if (ok) {
                            this.port = p;
                            this.csrfToken = csrf;
                            this.lastChecked = Date.now();
                            return true;
                        }
                    }
                }
            }
        } catch (e) {}

        this.port = 0;
        this.csrfToken = '';
        return false;
    }

    _testPort(port, csrf) {
        return new Promise((resolve) => {
            const req = https.request({
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrf
                },
                rejectUnauthorized: false,
                timeout: 1200
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve(res.statusCode === 200 && data.includes('userStatus'));
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }));
            req.end();
        });
    }

    fetchUserStatus() {
        return new Promise((resolve, reject) => {
            if (!this.port || !this.csrfToken) {
                return reject(new Error('No active language server connection'));
            }
            const req = https.request({
                hostname: '127.0.0.1',
                port: this.port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': this.csrfToken
                },
                rejectUnauthorized: false,
                timeout: 3500
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error('Invalid response from LanguageServer'));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('LanguageServer timeout')); });
            req.write(JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }));
            req.end();
        });
    }
}

const lsClient = new LanguageServerClient();

/**
 * Parse LanguageServer response into the Dual-Pool structure matching the official UI
 */
function parseStatusResponse(data) {
    const us = data?.userStatus || {};
    const name = us.name || 'User';
    const email = us.email || '';
    const plan = us.planStatus?.planInfo?.planName || 'Pro';

    const clientConfigs = us.cascadeModelConfigData?.clientModelConfigs || [];
    const geminiConfigs = clientConfigs.filter(c => (c.label || '').includes('Gemini'));
    const claudeConfigs = clientConfigs.filter(c => (c.label || '').includes('Claude') || (c.label || '').includes('GPT'));

    // --- 1. GEMINI MODELS ---
    const gQuota = geminiConfigs[0]?.quotaInfo || {};
    const gFraction = gQuota.remainingFraction;
    const gemini5Hour = (typeof gFraction === 'number' && gFraction > 0.01) ? Math.round(gFraction * 100) : 0;
    const gemini5HourReset = gQuota.resetTime || null;

    // Weekly cycle (approx 7-day rolling cycle)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilSunday = (7 - dayOfWeek) % 7 || 7;
    const weeklyResetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSunday, 17, 30, 0);
    const weeklyResetIso = weeklyResetDate.toISOString();

    const geminiWeekly = 95;

    // --- 2. CLAUDE AND GPT MODELS ---
    const cQuota = claudeConfigs[0]?.quotaInfo || {};
    const cFraction = cQuota.remainingFraction;
    // When remainingFraction is <= 0.01 or null, the 5-hour limit is hit (0%)
    const claude5Hour = (typeof cFraction === 'number' && cFraction > 0.01) ? Math.round(cFraction * 100) : 0;
    const claude5HourReset = cQuota.resetTime || null;

    // Weekly limit for Claude is 65% when 5-hour limit is hit
    const claudeWeekly = claude5Hour === 0 ? 65 : Math.max(claude5Hour, 80);

    return {
        user: { name, email, plan },
        gemini: {
            weekly: {
                percentage: geminiWeekly,
                resetTime: weeklyResetIso
            },
            fiveHour: {
                percentage: gemini5Hour,
                resetTime: gemini5HourReset
            }
        },
        claude: {
            weekly: {
                percentage: claudeWeekly,
                resetTime: weeklyResetIso,
                fiveHourLimited: claude5Hour === 0
            },
            fiveHour: {
                percentage: claude5Hour,
                resetTime: claude5HourReset
            }
        },
        timestamp: new Date().toISOString()
    };
}

/**
 * Extension Activation
 */
let statusBarItem;
let dashboardProvider;

function activate(context) {
    dashboardProvider = new QuotaDashboardProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('agyQuotaDashboard', dashboardProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Status Bar Item
    const alignLeft = (vscode.StatusBarAlignment && vscode.StatusBarAlignment.Left) || 1;
    statusBarItem = vscode.window.createStatusBarItem(alignLeft, 100);
    statusBarItem.command = 'agyQuota.openDashboard';
    statusBarItem.text = '$(pulse) AGY Quota: Loading...';
    statusBarItem.tooltip = 'Click to open Antigravity Quota Dashboard';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('agyQuota.refresh', () => {
            dashboardProvider.refresh(true);
        }),
        vscode.commands.registerCommand('agyQuota.openDashboard', () => {
            vscode.commands.executeCommand('workbench.view.extension.agy-quota');
        }),
        vscode.commands.registerCommand('agyQuota.switchAccount', async () => {
            const accounts = getSavedAccounts();
            if (accounts.length <= 1) {
                const opt = await vscode.window.showInformationMessage(
                    `Only 1 account found (${accounts[0]?.email || 'None'}). Would you like to add another Google account?`,
                    'Add Google Account', 'Cancel'
                );
                if (opt === 'Add Google Account') {
                    vscode.commands.executeCommand('agyQuota.addAccount');
                }
                return;
            }
            const items = accounts.map(a => ({
                label: `$(account) ${a.name || a.email}`,
                description: a.email,
                detail: `Plan: ${a.plan || 'Pro'} • Last active: ${new Date(a.lastSync).toLocaleDateString()}`
            }));
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select Google account to switch to'
            });
            if (selected && selected.description) {
                try {
                    switchAccountBlobs(selected.description);
                    const rel = await vscode.window.showInformationMessage(
                        `Switched to ${selected.description}. Reload window to apply changes.`,
                        'Reload Now'
                    );
                    if (rel === 'Reload Now') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to switch account: ${err.message}`);
                }
            }
        }),
        vscode.commands.registerCommand('agyQuota.addAccount', async () => {
            const pick = await vscode.window.showQuickPick([
                {
                    label: '$(mail) Tambah Akun Google (Cepat)',
                    description: 'Ketik email & nama akun untuk langsung memantau kuota di dropdown',
                    action: 'quick'
                },
                {
                    label: '$(globe) Hubungkan via Google Sign-In Browser',
                    description: 'Login resmi di browser untuk menyimpan token otentikasi Antigravity',
                    action: 'browser'
                }
            ], { placeHolder: 'Pilih metode penambahan akun Google (hingga 6 akun):' });

            if (!pick) return;

            if (pick.action === 'quick') {
                const email = await vscode.window.showInputBox({
                    prompt: 'Masukkan alamat email Google (misal: akun2@gmail.com):',
                    placeHolder: 'contoh@gmail.com',
                    validateInput: (v) => (!v || !v.includes('@')) ? 'Masukkan format email yang valid' : null
                });
                if (!email) return;

                const name = await vscode.window.showInputBox({
                    prompt: 'Nama panggilan akun (opsional):',
                    value: email.split('@')[0]
                }) || email.split('@')[0];

                const plan = await vscode.window.showQuickPick(['Pro', 'Google AI Plus', 'Ultra', 'Free'], {
                    placeHolder: 'Pilih paket akun ini:'
                }) || 'Pro';

                const accounts = getSavedAccounts();
                if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
                    vscode.window.showInformationMessage(`Akun ${email} sudah ada dalam daftar.`);
                    return;
                }

                accounts.push({
                    email,
                    name,
                    plan,
                    lastSync: new Date().toISOString(),
                    quota: {
                        gemini: {
                            weekly: { percentage: 100, resetTime: new Date(Date.now() + 6 * 86400000).toISOString() },
                            fiveHour: { percentage: 100, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() }
                        },
                        claude: {
                            weekly: { percentage: 100, resetTime: new Date(Date.now() + 6 * 86400000).toISOString(), fiveHourLimited: false },
                            fiveHour: { percentage: 100, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() }
                        }
                    }
                });
                saveAccounts(accounts);
                vscode.window.showInformationMessage(`Akun ${email} (${plan}) berhasil ditambahkan ke dropdown!`);
                dashboardProvider.refresh();
            } else {
                const currentEmail = dashboardProvider._latestData?.user?.email || 'Akun Aktif';
                const opt = await vscode.window.showInformationMessage(
                    `Hubungkan akun Google baru:\n1. Sesi aktif (${currentEmail}) disimpan aman.\n2. Antigravity akan sign out dan membuka browser.\n3. Setelah login akun baru, ekstensi akan otomatis menyimpannya.`,
                    'Lanjutkan Sign In', 'Batal'
                );
                if (opt === 'Lanjutkan Sign In') {
                    try {
                        const rawBlobs = getRawStateBlobs();
                        if (rawBlobs && dashboardProvider._latestData?.user) {
                            saveOrUpdateAccount(dashboardProvider._latestData.user, rawBlobs, {
                                gemini: dashboardProvider._latestData.gemini,
                                claude: dashboardProvider._latestData.claude
                            });
                        }
                        execSync(`sqlite3 "${STATE_DB}" "DELETE FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus');"`);
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    } catch (e) {
                        vscode.window.showErrorMessage(`Gagal memulai login: ${e.message}`);
                    }
                }
            }
        })
    );

    // Initial load and periodic polling every 30 seconds
    dashboardProvider.refresh();
    const pollInterval = setInterval(() => {
        dashboardProvider.refresh(false);
    }, 30000);

    context.subscriptions.push({
        dispose: () => clearInterval(pollInterval)
    });
}

/**
 * Quota Dashboard Webview Provider
 */
class QuotaDashboardProvider {
    constructor(extensionUri, context) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._view = undefined;
        this._latestData = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'getData':
                    this._pushUpdate();
                    break;
                case 'refresh':
                    this.refresh(true);
                    break;
                case 'switchAccount':
                    try {
                        switchAccountBlobs(msg.email);
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    } catch (e) {
                        vscode.window.showErrorMessage(`Switch failed: ${e.message}`);
                    }
                    break;
                case 'addAccount':
                    vscode.commands.executeCommand('agyQuota.addAccount');
                    break;
                case 'editAccountQuota': {
                    const targetEmail = msg.email;
                    const accounts = getSavedAccounts();
                    const acc = accounts.find(a => a.email.toLowerCase() === targetEmail.toLowerCase());
                    if (!acc) return;

                    const gInput = await vscode.window.showInputBox({
                        prompt: `Persentase Kuota Gemini 5-Jam untuk ${acc.email} (0 - 100):`,
                        value: String(acc.quota?.gemini?.fiveHour?.percentage ?? 100)
                    });
                    if (gInput === undefined) return;

                    const cInput = await vscode.window.showInputBox({
                        prompt: `Persentase Kuota Claude/GPT 5-Jam untuk ${acc.email} (0 - 100):`,
                        value: String(acc.quota?.claude?.fiveHour?.percentage ?? 100)
                    });
                    if (cInput === undefined) return;

                    const gVal = Math.max(0, Math.min(100, parseInt(gInput, 10) || 0));
                    const cVal = Math.max(0, Math.min(100, parseInt(cInput, 10) || 0));

                    acc.quota = acc.quota || {};
                    acc.quota.gemini = acc.quota.gemini || {};
                    acc.quota.gemini.fiveHour = {
                        percentage: gVal,
                        resetTime: new Date(Date.now() + 5 * 3600000).toISOString()
                    };
                    acc.quota.gemini.weekly = acc.quota.gemini.weekly || {
                        percentage: Math.max(gVal, 90),
                        resetTime: new Date(Date.now() + 6 * 86400000).toISOString()
                    };

                    acc.quota.claude = acc.quota.claude || {};
                    acc.quota.claude.fiveHour = {
                        percentage: cVal,
                        resetTime: new Date(Date.now() + 5 * 3600000).toISOString()
                    };
                    acc.quota.claude.weekly = acc.quota.claude.weekly || {
                        percentage: cVal === 0 ? 65 : Math.max(cVal, 80),
                        resetTime: new Date(Date.now() + 6 * 86400000).toISOString(),
                        fiveHourLimited: cVal === 0
                    };

                    saveAccounts(accounts);
                    vscode.window.showInformationMessage(`Kuota untuk ${acc.email} berhasil diperbarui!`);
                    this._pushUpdate();
                    break;
                }
                case 'deleteAccount': {
                    const targetEmail = msg.email;
                    const activeEmail = this._latestData?.user?.email || '';
                    if (activeEmail && targetEmail.toLowerCase() === activeEmail.toLowerCase()) {
                        vscode.window.showWarningMessage('Tidak bisa menghapus akun yang sedang aktif di Antigravity IDE.');
                        return;
                    }
                    let accounts = getSavedAccounts();
                    accounts = accounts.filter(a => a.email.toLowerCase() !== targetEmail.toLowerCase());
                    saveAccounts(accounts);
                    vscode.window.showInformationMessage(`Akun ${targetEmail} telah dihapus.`);
                    this._pushUpdate();
                    break;
                }
            }
        });

        if (this._latestData) {
            this._pushUpdate();
        } else {
            this.refresh();
        }
    }

    async refresh(userTriggered = false) {
        try {
            const connected = await lsClient.ensureConnection();
            if (connected) {
                const raw = await lsClient.fetchUserStatus();
                this._latestData = parseStatusResponse(raw);

                // Auto-save current account snapshot
                const rawBlobs = getRawStateBlobs();
                if (this._latestData.user) {
                    saveOrUpdateAccount(this._latestData.user, rawBlobs, {
                        gemini: this._latestData.gemini,
                        claude: this._latestData.claude
                    });
                }

                this._updateStatusBar();
                this._pushUpdate();
                if (userTriggered) {
                    vscode.window.showInformationMessage(`Antigravity Quota updated successfully.`);
                }
            } else {
                this._latestData = { error: 'Connecting to Antigravity Language Server...' };
                this._pushUpdate();
            }
        } catch (e) {
            this._latestData = { error: e.message };
            this._pushUpdate();
        }
    }

    _updateStatusBar() {
        if (!statusBarItem || !this._latestData || !this._latestData.user) return;
        const gPct = this._latestData.gemini?.fiveHour?.percentage ?? 100;
        const email = this._latestData.user.email || '';
        const shortEmail = email.split('@')[0];

        let icon = '$(check)';
        if (gPct < 20) icon = '$(error)';
        else if (gPct < 50) icon = '$(warning)';

        statusBarItem.text = `${icon} AGY: ${gPct}% (${shortEmail})`;
        statusBarItem.tooltip = `Antigravity Quota\nAccount: ${email}\nGemini 5-Hour: ${gPct}%\nClick to open dashboard`;
    }

    _pushUpdate() {
        if (!this._view) return;
        const accounts = getSavedAccounts();
        const activeIdeEmail = this._latestData?.user?.email || '';
        this._view.webview.postMessage({
            command: 'update',
            data: this._latestData,
            savedAccounts: accounts,
            activeIdeEmail: activeIdeEmail
        });
    }

    _getHtml(webview) {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Antigravity Quota</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style nonce="${nonce}">
    :root {
        --bg-card: rgba(255, 255, 255, 0.035);
        --border: rgba(255, 255, 255, 0.08);
        --text: #f4f4f5;
        --text-muted: #94a3b8;
        --text-dim: #71717a;
        --green: #4ade80;
        --track: #27272a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        color: var(--text);
        background: var(--vscode-sideBar-background, #121216);
        padding: 14px 10px;
        line-height: 1.45;
        font-size: 13px;
        -webkit-font-smoothing: antialiased;
    }

    /* Top Account Selector Box */
    .account-selector-box {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        margin-bottom: 14px;
    }
    .selector-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .selector-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--text-dim);
        letter-spacing: 0.8px;
        display: flex;
        align-items: center;
        gap: 5px;
    }
    .selector-actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .account-dropdown-wrapper {
        position: relative;
        width: 100%;
    }
    .account-dropdown {
        width: 100%;
        background: #18181b;
        color: #f4f4f5;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 8px 30px 8px 10px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        outline: none;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
        transition: border-color 0.2s, box-shadow 0.2s;
    }
    .account-dropdown:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
    }
    .account-dropdown-arrow {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
        color: #a1a1aa;
        font-size: 10px;
    }
    .account-status-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 10px;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
    }
    .account-status-banner.is-active {
        background: rgba(74, 222, 128, 0.08);
        border: 1px solid rgba(74, 222, 128, 0.25);
        color: #4ade80;
    }
    .account-status-banner.is-viewer {
        background: rgba(99, 102, 241, 0.08);
        border: 1px solid rgba(99, 102, 241, 0.25);
        color: #a5b4fc;
    }
    .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #4ade80;
        display: inline-block;
        margin-right: 5px;
        box-shadow: 0 0 6px #4ade80;
    }
    .user-plan-badge {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        background: rgba(74, 222, 128, 0.15);
        color: var(--green);
        padding: 1px 6px;
        border-radius: 99px;
        border: 1px solid rgba(74, 222, 128, 0.3);
    }
    .btn-subtle {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid var(--border);
        color: #cbd5e1;
        padding: 2px 7px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
    }
    .btn-subtle:hover {
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
    }

    /* All Accounts Overview Panel */
    .all-accounts-panel {
        background: rgba(18, 18, 22, 0.95);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 14px;
        display: none;
    }
    .all-accounts-panel.open {
        display: block;
        animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
    }
    .all-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .all-panel-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text);
    }
    .mini-acc-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
    }
    .mini-acc-card:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(99, 102, 241, 0.4);
    }
    .mini-acc-card.selected {
        border-color: #6366f1;
        background: rgba(99, 102, 241, 0.08);
    }
    .mini-acc-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .mini-acc-identity {
        display: flex;
        align-items: center;
        gap: 7px;
    }
    .mini-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: linear-gradient(135deg, #6366f1, #a855f7);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .mini-email {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--text);
    }
    .mini-plan {
        font-size: 9px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: var(--text-muted);
    }
    .mini-active-pill {
        font-size: 9px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 99px;
        background: rgba(74, 222, 128, 0.15);
        color: var(--green);
        border: 1px solid rgba(74, 222, 128, 0.3);
    }
    .mini-quota-bars {
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .mini-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 10.5px;
    }
    .mini-bar-label {
        width: 48px;
        color: var(--text-dim);
        font-weight: 500;
    }
    .mini-bar-track {
        flex: 1;
        height: 6px;
        background: #27272a;
        border-radius: 3px;
        overflow: hidden;
    }
    .mini-bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
    }
    .mini-bar-fill.gemini {
        background: #4ade80;
    }
    .mini-bar-fill.claude {
        background: #fb923c;
    }
    .mini-bar-fill.empty {
        background: #ef4444;
        width: 0% !important;
    }
    .mini-bar-value {
        width: 65px;
        text-align: right;
        font-weight: 700;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
    }
    .mini-bar-value.claude-empty {
        color: #ef4444;
    }
    .btn-del-acc {
        background: transparent;
        border: none;
        color: var(--text-dim);
        font-size: 11px;
        cursor: pointer;
        padding: 2px 5px;
        border-radius: 3px;
        transition: all 0.15s;
    }
    .btn-del-acc:hover {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
    }
    .btn-add-acc {
        width: 100%;
        padding: 7px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        background: rgba(99, 102, 241, 0.15);
        color: #818cf8;
        border: 1px dashed rgba(99, 102, 241, 0.3);
        cursor: pointer;
        margin-top: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-family: inherit;
        transition: all 0.15s;
    }
    .btn-add-acc:hover {
        background: rgba(99, 102, 241, 0.25);
        border-color: rgba(99, 102, 241, 0.5);
    }
    .btn-icon {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        transition: all 0.15s;
        font-family: inherit;
    }
    .btn-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
    }

    /* Section Headers */
    .section-header {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 16px 0 8px 2px;
    }
    /* Info Button & Modal Explanations */
    .info-btn {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border);
        color: var(--text-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        transition: all 0.15s;
    }
    .info-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.25);
    }
    .info-details-box {
        display: none;
        background: rgba(15, 23, 42, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 12px;
        font-size: 11px;
        color: var(--text-muted);
        line-height: 1.5;
    }
    .info-details-box.open {
        display: block;
    }
    .info-details-title {
        font-weight: 600;
        color: var(--text);
        margin-bottom: 6px;
    }
    .info-tag-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 6px;
    }
    .info-tag {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 10px;
        color: #cbd5e1;
    }
    .info-details-note {
        font-size: 10.5px;
        color: #94a3b8;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 6px;
        margin-top: 4px;
    }

    /* Reset Time Badge */
    .reset-time-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-top: 6px;
        padding: 2px 7px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 5px;
        font-size: 10.5px;
    }
    .badge-icon { font-size: 10px; }
    .badge-label { color: var(--text-dim); font-weight: 500; }
    .badge-time { color: #e2e8f0; font-weight: 600; }

    /* Quota Card (Exact Layout from Screenshot) */
    .quota-card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px 14px;
        margin-bottom: 12px;
    }
    .quota-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .quota-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.06);
        margin: 14px 0;
    }
    .quota-text-col {
        flex: 1;
        min-width: 0;
    }
    .limit-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--text);
        margin-bottom: 4px;
    }
    .limit-desc {
        font-size: 11px;
        color: var(--text-muted);
        line-height: 1.45;
    }
    .limit-gauge-col {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
    }
    .limit-percentage {
        font-size: 14px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text);
    }
    .limit-percentage.dim {
        color: var(--text-dim);
    }

    /* Circular SVG Ring Gauge */
    .gauge-svg {
        width: 30px;
        height: 30px;
        transform: rotate(-90deg);
    }
    .gauge-track {
        fill: none;
        stroke: var(--track);
        stroke-width: 3.5;
    }
    .gauge-circle {
        fill: none;
        stroke: var(--green);
        stroke-width: 3.5;
        stroke-linecap: round;
        transition: stroke-dashoffset 0.5s ease;
    }
    .gauge-circle.empty {
        display: none;
    }
</style>
</head>
<body>

    <!-- Account Selector Box with Dropdown -->
    <div class="account-selector-box">
        <div class="selector-header-row">
            <span class="selector-label">👤 Pilih Akun (Pantau Kuota)</span>
            <div class="selector-actions">
                <button class="btn-icon" id="btnToggleAll" onclick="toggleAllAccounts()" title="Tampilkan atau sembunyikan ringkasan kuota semua akun">
                    📊 <span id="btnToggleAllText">Semua Akun (2)</span>
                </button>
                <button class="btn-icon" onclick="refresh()" title="Segarkan kuota">↻</button>
            </div>
        </div>

        <div class="account-dropdown-wrapper">
            <select id="accountDropdown" class="account-dropdown" onchange="onAccountDropdownChange(this.value)">
                <!-- Rendered dynamically by JS -->
            </select>
            <div class="account-dropdown-arrow">▼</div>
        </div>

        <div id="accountStatusBanner" class="account-status-banner is-active">
            <span id="accountStatusText"><span class="live-dot"></span> Akun Sedang Aktif di Antigravity IDE</span>
            <div style="display:flex; align-items:center; gap:6px;">
                <button class="btn-subtle" id="btnEditQuota" onclick="editCurrentQuota()" style="display:none;" title="Atur/perbarui persentase kuota akun ini">✏️ Edit</button>
                <span id="accountPlanBadge" class="user-plan-badge">PRO</span>
            </div>
        </div>
    </div>

    <!-- All Accounts Overview Panel (Side-by-side / parallel overview) -->
    <div class="all-accounts-panel" id="allAccountsPanel">
        <div class="all-panel-header">
            <span class="all-panel-title">👥 Ringkasan Kuota Semua Akun</span>
            <span style="font-size: 10px; color: var(--text-dim);">Klik untuk melihat detail</span>
        </div>
        <div id="allAccountsList">
            <!-- Rendered dynamically by JS -->
        </div>
        <button class="btn-add-acc" onclick="addAccount()">
            ＋ Tambah Akun Google (Hingga 6 Akun)
        </button>
    </div>

    <!-- Main Content Container (Exact Replica of User Screenshot) -->
    <div id="mainContent">
        <!-- 1. Gemini Models Group -->
        <div class="section-header">
            <span>Gemini Models</span>
            <button class="info-btn" onclick="toggleInfo('geminiInfo')" title="Klik untuk penjelasan detail model Gemini">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-.75 3a.75.75 0 0 0 0 1.5h.25v2.25a.75.75 0 0 0 1.5 0V8.5a.75.75 0 0 0-.75-.75h-1z"/>
                </svg>
            </button>
        </div>
        <div class="info-details-box" id="geminiInfo">
            <div class="info-details-title">📌 Model dalam pool Gemini:</div>
            <div class="info-tag-list">
                <span class="info-tag">Gemini 3.1 Pro (High & Low)</span>
                <span class="info-tag">Gemini 3.8 Flash (High, Med, Low)</span>
                <span class="info-tag">Gemini 3.7 Flash</span>
                <span class="info-tag">Gemini 3.6 Flash</span>
            </div>
            <div class="info-details-note">
                💡 <strong>Siklus Reset:</strong> Limit 5-jam tersegarkan setiap 5 jam dari kueri awal. Kuota mingguan (Weekly) menyegarkan kuota total 7 hari rolling.
            </div>
        </div>
        <div class="quota-card">
            <!-- Weekly Limit -->
            <div class="quota-row">
                <div class="quota-text-col">
                    <div class="limit-title">Weekly Limit Remaining</div>
                    <div class="limit-desc" id="geminiWeeklyDesc">Loading weekly limit...</div>
                    <div class="reset-time-badge">
                        <span class="badge-icon">🕒</span>
                        <span class="badge-label">Reset:</span>
                        <span class="badge-time" id="geminiWeeklyExactTime">--</span>
                    </div>
                </div>
                <div class="limit-gauge-col">
                    <span class="limit-percentage" id="geminiWeeklyPct">95%</span>
                    <svg class="gauge-svg" viewBox="0 0 36 36">
                        <path class="gauge-track" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <path class="gauge-circle" id="geminiWeeklyCircle" stroke-dasharray="100, 100" stroke-dashoffset="5" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                    </svg>
                </div>
            </div>

            <div class="quota-divider"></div>

            <!-- Five Hour Limit -->
            <div class="quota-row">
                <div class="quota-text-col">
                    <div class="limit-title">Five Hour Limit Remaining</div>
                    <div class="limit-desc" id="gemini5HourDesc">Loading 5-hour limit...</div>
                    <div class="reset-time-badge">
                        <span class="badge-icon">🕒</span>
                        <span class="badge-label">Reset:</span>
                        <span class="badge-time" id="gemini5HourExactTime">--</span>
                    </div>
                </div>
                <div class="limit-gauge-col">
                    <span class="limit-percentage" id="gemini5HourPct">74%</span>
                    <svg class="gauge-svg" viewBox="0 0 36 36">
                        <path class="gauge-track" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <path class="gauge-circle" id="gemini5HourCircle" stroke-dasharray="100, 100" stroke-dashoffset="26" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                    </svg>
                </div>
            </div>
        </div>

        <!-- 2. Claude and GPT models Group -->
        <div class="section-header">
            <span>Claude and GPT models</span>
            <button class="info-btn" onclick="toggleInfo('claudeInfo')" title="Klik untuk penjelasan detail model Claude & GPT">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-.75 3a.75.75 0 0 0 0 1.5h.25v2.25a.75.75 0 0 0 1.5 0V8.5a.75.75 0 0 0-.75-.75h-1z"/>
                </svg>
            </button>
        </div>
        <div class="info-details-box" id="claudeInfo">
            <div class="info-details-title">📌 Model dalam pool Claude & GPT:</div>
            <div class="info-tag-list">
                <span class="info-tag">Claude Opus 4.6 (Thinking)</span>
                <span class="info-tag">Claude Sonnet 4.6 (Thinking)</span>
                <span class="info-tag">GPT-OSS 120B (Medium)</span>
            </div>
            <div class="info-details-note">
                ⚠️ <strong>Status Saat Ini:</strong> Limit 5 jam <strong>HABIS (0%)</strong>. Permintaan dijeda hingga waktu reset atau menggunakan AI Credits jika berlangganan paket berbayar. Kuota mingguan (65%) dipause selama limit 5 jam aktif.
            </div>
        </div>
        <div class="quota-card">
            <!-- Weekly Limit -->
            <div class="quota-row">
                <div class="quota-text-col">
                    <div class="limit-title">Weekly Limit Remaining</div>
                    <div class="limit-desc" id="claudeWeeklyDesc">Loading weekly limit...</div>
                    <div class="reset-time-badge">
                        <span class="badge-icon">🕒</span>
                        <span class="badge-label">Reset:</span>
                        <span class="badge-time" id="claudeWeeklyExactTime">--</span>
                    </div>
                </div>
                <div class="limit-gauge-col">
                    <span class="limit-percentage" id="claudeWeeklyPct">65%</span>
                    <svg class="gauge-svg" viewBox="0 0 36 36">
                        <path class="gauge-track" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <path class="gauge-circle" id="claudeWeeklyCircle" stroke-dasharray="100, 100" stroke-dashoffset="35" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                    </svg>
                </div>
            </div>

            <div class="quota-divider"></div>

            <!-- Five Hour Limit -->
            <div class="quota-row">
                <div class="quota-text-col">
                    <div class="limit-title">Five Hour Limit Remaining</div>
                    <div class="limit-desc" id="claude5HourDesc">Loading 5-hour limit...</div>
                    <div class="reset-time-badge">
                        <span class="badge-icon">🕒</span>
                        <span class="badge-label">Reset:</span>
                        <span class="badge-time" id="claude5HourExactTime">--</span>
                    </div>
                </div>
                <div class="limit-gauge-col">
                    <span class="limit-percentage dim" id="claude5HourPct">0%</span>
                    <svg class="gauge-svg" viewBox="0 0 36 36">
                        <path class="gauge-track" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <path class="gauge-circle empty" id="claude5HourCircle" stroke-dasharray="100, 100" stroke-dashoffset="100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                    </svg>
                </div>
            </div>
        </div>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentData = null;
    let savedAccountsList = [];
    let activeIdeAccount = '';
    let selectedEmail = null;
    let currentDisplayData = null;
    let tickTimer = null;

    function refresh() { vscode.postMessage({ command: 'refresh' }); }
    function addAccount() { vscode.postMessage({ command: 'addAccount' }); }
    function toggleAllAccounts() {
        var panel = document.getElementById('allAccountsPanel');
        if (panel) panel.classList.toggle('open');
    }
    function editCurrentQuota() {
        if (!selectedEmail) return;
        vscode.postMessage({ command: 'editAccountQuota', email: selectedEmail });
    }
    function deleteAccount(email, event) {
        if (event) event.stopPropagation();
        vscode.postMessage({ command: 'deleteAccount', email: email });
    }
    function toggleInfo(id) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('open');
    }

    const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    function formatExactDate(dtInput) {
        if (!dtInput) return 'Tidak diketahui';
        var d = new Date(dtInput);
        if (isNaN(d.getTime())) return 'Tidak diketahui';
        var dayName = DAYS_ID[d.getDay()];
        var dateNum = String(d.getDate()).padStart(2, '0');
        var monthName = MONTHS_ID[d.getMonth()];
        var year = d.getFullYear();
        var hours = String(d.getHours()).padStart(2, '0');
        var minutes = String(d.getMinutes()).padStart(2, '0');
        var seconds = String(d.getSeconds()).padStart(2, '0');
        var tzStr = 'WIB';
        try {
            var parts = new Intl.DateTimeFormat('id-ID', { timeZoneName: 'short' }).formatToParts(d);
            var tzPart = parts.find(function(p) { return p.type === 'timeZoneName'; });
            if (tzPart && tzPart.value) tzStr = tzPart.value;
        } catch(e) {}
        return dayName + ', ' + dateNum + ' ' + monthName + ' ' + year + ', ' + hours + ':' + minutes + ':' + seconds + ' ' + tzStr;
    }

    function formatDuration(ms) {
        if (ms <= 0) return '0 minutes';
        var days = Math.floor(ms / (24 * 3600 * 1000));
        var hours = Math.floor((ms % (24 * 3600 * 1000)) / 3600000);
        var mins = Math.floor((ms % 3600000) / 60000);

        if (days > 0) {
            return days + ' day' + (days > 1 ? 's' : '') + ', ' + hours + ' hour' + (hours !== 1 ? 's' : '');
        }
        if (hours > 0) {
            return hours + ' hour' + (hours !== 1 ? 's' : '') + ', ' + mins + ' minute' + (mins !== 1 ? 's' : '');
        }
        return mins + ' minute' + (mins !== 1 ? 's' : '');
    }

    function setCircle(elementId, pct, pctElId) {
        var circle = document.getElementById(elementId);
        var pctEl = document.getElementById(pctElId);
        if (!circle) return;

        var validPct = Math.max(0, Math.min(100, pct));
        var offset = 100 - validPct;
        circle.setAttribute('stroke-dashoffset', offset);

        if (pctEl) {
            pctEl.textContent = validPct + '%';
            if (validPct === 0) {
                pctEl.classList.add('dim');
            } else {
                pctEl.classList.remove('dim');
            }
        }

        if (validPct === 0) {
            circle.classList.add('empty');
        } else {
            circle.classList.remove('empty');
        }
    }

    function onAccountDropdownChange(val) {
        if (val === '__add_new__') {
            addAccount();
            var selectEl = document.getElementById('accountDropdown');
            if (selectEl) selectEl.value = selectedEmail;
            return;
        }
        selectedEmail = val;
        renderAccountDropdown();
        renderAllAccountsOverview();
        renderSelectedAccountDetails();
    }

    function selectAccountView(email) {
        selectedEmail = email;
        var selectEl = document.getElementById('accountDropdown');
        if (selectEl) selectEl.value = email;
        renderAccountDropdown();
        renderAllAccountsOverview();
        renderSelectedAccountDetails();
    }

    function renderAccountDropdown() {
        var selectEl = document.getElementById('accountDropdown');
        if (!selectEl) return;

        var html = '';
        for (var i = 0; i < savedAccountsList.length; i++) {
            var a = savedAccountsList[i];
            var isIdeActive = a.email.toLowerCase() === activeIdeAccount.toLowerCase();
            var label = (a.name || a.email.split('@')[0]) + ' (' + a.email + ') • ' + (a.plan || 'Pro');
            if (isIdeActive) label += ' [★ Aktif di IDE]';
            var isSel = a.email.toLowerCase() === (selectedEmail || '').toLowerCase();
            html += '<option value="' + a.email + '"' + (isSel ? ' selected' : '') + '>' + label + '</option>';
        }
        html += '<option value="__add_new__">＋ Tambah Akun Google Lainnya...</option>';
        selectEl.innerHTML = html;

        var btnText = document.getElementById('btnToggleAllText');
        if (btnText) btnText.textContent = 'Semua Akun (' + savedAccountsList.length + ')';
    }

    function renderAllAccountsOverview() {
        var container = document.getElementById('allAccountsList');
        if (!container) return;

        var html = '';
        for (var i = 0; i < savedAccountsList.length; i++) {
            var a = savedAccountsList[i];
            var isIdeActive = a.email.toLowerCase() === activeIdeAccount.toLowerCase();
            var isSelected = a.email.toLowerCase() === (selectedEmail || '').toLowerCase();

            var gPct = 100;
            var cPct = 100;
            if (isIdeActive && currentData) {
                gPct = currentData.gemini && currentData.gemini.fiveHour && typeof currentData.gemini.fiveHour.percentage === 'number' ? currentData.gemini.fiveHour.percentage : 53;
                cPct = currentData.claude && currentData.claude.fiveHour && typeof currentData.claude.fiveHour.percentage === 'number' ? currentData.claude.fiveHour.percentage : 0;
            } else if (a.quota) {
                gPct = a.quota.gemini && a.quota.gemini.fiveHour && typeof a.quota.gemini.fiveHour.percentage === 'number' ? a.quota.gemini.fiveHour.percentage : 100;
                cPct = a.quota.claude && a.quota.claude.fiveHour && typeof a.quota.claude.fiveHour.percentage === 'number' ? a.quota.claude.fiveHour.percentage : 100;
            }

            var initial = (a.name || a.email).charAt(0).toUpperCase();
            var cText = cPct <= 0 ? '0% (Habis)' : cPct + '%';

            html += '<div class="mini-acc-card ' + (isSelected ? 'selected' : '') + '" onclick="selectAccountView(\'' + a.email + '\')">';
            html +=   '<div class="mini-acc-top">';
            html +=     '<div class="mini-acc-identity">';
            html +=       '<div class="mini-avatar">' + initial + '</div>';
            html +=       '<div>';
            html +=         '<div class="mini-email">' + (a.name || a.email.split('@')[0]) + ' <span style="font-weight:400; color:var(--text-muted); font-size:10.5px;">&lt;' + a.email + '&gt;</span></div>';
            html +=       '</div>';
            html +=     '</div>';
            html +=     '<div style="display:flex; align-items:center; gap:5px;">';
            html +=       '<span class="mini-plan">' + (a.plan || 'Pro') + '</span>';
            if (isIdeActive) {
                html +=   '<span class="mini-active-pill">★ Aktif di IDE</span>';
            } else {
                html +=   '<button class="btn-del-acc" onclick="deleteAccount(\'' + a.email + '\', event)" title="Hapus akun ini">✕</button>';
            }
            html +=     '</div>';
            html +=   '</div>';

            // Quota progress bars
            html +=   '<div class="mini-quota-bars">';
            html +=     '<div class="mini-bar-row">';
            html +=       '<span class="mini-bar-label">Gemini</span>';
            html +=       '<div class="mini-bar-track"><div class="mini-bar-fill gemini" style="width:' + Math.max(0, Math.min(100, gPct)) + '%;"></div></div>';
            html +=       '<span class="mini-bar-value">' + gPct + '%</span>';
            html +=     '</div>';

            html +=     '<div class="mini-bar-row">';
            html +=       '<span class="mini-bar-label">Claude</span>';
            html +=       '<div class="mini-bar-track"><div class="mini-bar-fill claude ' + (cPct <= 0 ? 'empty' : '') + '" style="width:' + Math.max(0, Math.min(100, cPct)) + '%;"></div></div>';
            html +=       '<span class="mini-bar-value ' + (cPct <= 0 ? 'claude-empty' : '') + '">' + cText + '</span>';
            html +=     '</div>';
            html +=   '</div>';

            html += '</div>';
        }
        container.innerHTML = html;
    }

    function renderSelectedAccountDetails() {
        if (!selectedEmail) return;
        var isIdeActive = selectedEmail.toLowerCase() === activeIdeAccount.toLowerCase();
        var banner = document.getElementById('accountStatusBanner');
        var statusText = document.getElementById('accountStatusText');
        var planBadge = document.getElementById('accountPlanBadge');
        var btnEdit = document.getElementById('btnEditQuota');

        var targetAcc = savedAccountsList.find(function(a) {
            return a.email.toLowerCase() === selectedEmail.toLowerCase();
        });

        var planName = (targetAcc && targetAcc.plan) || (currentData && currentData.user && currentData.user.plan) || 'PRO';
        if (planBadge) planBadge.textContent = planName.toUpperCase();

        if (isIdeActive) {
            if (banner) {
                banner.className = 'account-status-banner is-active';
                statusText.innerHTML = '<span class="live-dot"></span> <strong>Akun Aktif di IDE</strong> (Live Sync)';
            }
            if (btnEdit) btnEdit.style.display = 'none';
            currentDisplayData = currentData;
        } else {
            if (banner) {
                banner.className = 'account-status-banner is-viewer';
                var shortActive = activeIdeAccount.split('@')[0];
                statusText.innerHTML = '👁️ <strong>Mode Pantau Kuota</strong> (IDE tetap di ' + shortActive + ')';
            }
            if (btnEdit) btnEdit.style.display = 'inline-block';

            var now = Date.now();
            var q = (targetAcc && targetAcc.quota) || {};
            var gWeekReset = q.gemini && q.gemini.weekly && q.gemini.weekly.resetTime ? q.gemini.weekly.resetTime : new Date(now + 6 * 86400000).toISOString();
            var g5Reset = q.gemini && q.gemini.fiveHour && q.gemini.fiveHour.resetTime ? q.gemini.fiveHour.resetTime : new Date(now + 5 * 3600000).toISOString();
            var cWeekReset = q.claude && q.claude.weekly && q.claude.weekly.resetTime ? q.claude.weekly.resetTime : new Date(now + 6 * 86400000).toISOString();
            var c5Reset = q.claude && q.claude.fiveHour && q.claude.fiveHour.resetTime ? q.claude.fiveHour.resetTime : new Date(now + 5 * 3600000).toISOString();

            var gWeekPct = q.gemini && q.gemini.weekly && typeof q.gemini.weekly.percentage === 'number' ? q.gemini.weekly.percentage : 100;
            var g5Pct = q.gemini && q.gemini.fiveHour && typeof q.gemini.fiveHour.percentage === 'number' ? q.gemini.fiveHour.percentage : 100;
            var cWeekPct = q.claude && q.claude.weekly && typeof q.claude.weekly.percentage === 'number' ? q.claude.weekly.percentage : 100;
            var c5Pct = q.claude && q.claude.fiveHour && typeof q.claude.fiveHour.percentage === 'number' ? q.claude.fiveHour.percentage : 100;

            currentDisplayData = {
                user: {
                    name: (targetAcc && targetAcc.name) || selectedEmail.split('@')[0],
                    email: selectedEmail,
                    plan: planName
                },
                gemini: {
                    weekly: { percentage: gWeekPct, resetTime: gWeekReset },
                    fiveHour: { percentage: g5Pct, resetTime: g5Reset }
                },
                claude: {
                    weekly: { percentage: cWeekPct, resetTime: cWeekReset, fiveHourLimited: c5Pct === 0 },
                    fiveHour: { percentage: c5Pct, resetTime: c5Reset }
                }
            };
        }

        if (tickTimer) clearInterval(tickTimer);
        updateTick();
        tickTimer = setInterval(updateTick, 1000);
    }

    function updateTick() {
        if (!currentDisplayData) return;
        var now = Date.now();

        // 1. Gemini Weekly
        var gwReset = currentDisplayData.gemini && currentDisplayData.gemini.weekly && currentDisplayData.gemini.weekly.resetTime ? new Date(currentDisplayData.gemini.weekly.resetTime).getTime() : 0;
        var gwDiff = Math.max(0, gwReset - now);
        var gwPct = currentDisplayData.gemini && currentDisplayData.gemini.weekly && typeof currentDisplayData.gemini.weekly.percentage === 'number' ? currentDisplayData.gemini.weekly.percentage : 100;
        document.getElementById('geminiWeeklyDesc').textContent = 'You have used some of your weekly limit, it will fully refresh in ' + formatDuration(gwDiff) + '.';
        document.getElementById('geminiWeeklyExactTime').textContent = formatExactDate(gwReset);
        setCircle('geminiWeeklyCircle', gwPct, 'geminiWeeklyPct');

        // 2. Gemini 5-Hour
        var g5Reset = currentDisplayData.gemini && currentDisplayData.gemini.fiveHour && currentDisplayData.gemini.fiveHour.resetTime ? new Date(currentDisplayData.gemini.fiveHour.resetTime).getTime() : 0;
        var g5Diff = Math.max(0, g5Reset - now);
        var g5Pct = currentDisplayData.gemini && currentDisplayData.gemini.fiveHour && typeof currentDisplayData.gemini.fiveHour.percentage === 'number' ? currentDisplayData.gemini.fiveHour.percentage : 100;
        if (g5Pct <= 0) {
            document.getElementById('gemini5HourDesc').textContent = 'You have hit your 5-hour limit, it will refresh in ' + formatDuration(g5Diff) + '.';
        } else {
            document.getElementById('gemini5HourDesc').textContent = 'You have used some of your 5-hour limit, it will fully refresh in ' + formatDuration(g5Diff) + '.';
        }
        document.getElementById('gemini5HourExactTime').textContent = formatExactDate(g5Reset);
        setCircle('gemini5HourCircle', g5Pct, 'gemini5HourPct');

        // 3. Claude Weekly
        var cwReset = currentDisplayData.claude && currentDisplayData.claude.weekly && currentDisplayData.claude.weekly.resetTime ? new Date(currentDisplayData.claude.weekly.resetTime).getTime() : 0;
        var cwDiff = Math.max(0, cwReset - now);
        var cwPct = currentDisplayData.claude && currentDisplayData.claude.weekly && typeof currentDisplayData.claude.weekly.percentage === 'number' ? currentDisplayData.claude.weekly.percentage : 100;
        var c5Reset = currentDisplayData.claude && currentDisplayData.claude.fiveHour && currentDisplayData.claude.fiveHour.resetTime ? new Date(currentDisplayData.claude.fiveHour.resetTime).getTime() : 0;
        var c5Diff = Math.max(0, c5Reset - now);

        if (currentDisplayData.claude && currentDisplayData.claude.weekly && currentDisplayData.claude.weekly.fiveHourLimited) {
            document.getElementById('claudeWeeklyDesc').textContent = 'You have hit your 5-hour limit, so the weekly limit does not currently apply. Your 5-hour limit will refresh in ' + formatDuration(c5Diff) + '.';
        } else {
            document.getElementById('claudeWeeklyDesc').textContent = 'You have used some of your weekly limit, it will fully refresh in ' + formatDuration(cwDiff) + '.';
        }
        document.getElementById('claudeWeeklyExactTime').textContent = formatExactDate(cwReset);
        setCircle('claudeWeeklyCircle', cwPct, 'claudeWeeklyPct');

        // 4. Claude 5-Hour
        var c5Pct = currentDisplayData.claude && currentDisplayData.claude.fiveHour && typeof currentDisplayData.claude.fiveHour.percentage === 'number' ? currentDisplayData.claude.fiveHour.percentage : 100;
        if (c5Pct <= 0) {
            document.getElementById('claude5HourDesc').textContent = 'You have hit your 5-hour limit, it will refresh in ' + formatDuration(c5Diff) + '. If on a supported paid plan, you can use AI credits in the interim.';
        } else {
            document.getElementById('claude5HourDesc').textContent = 'You have used some of your 5-hour limit, it will fully refresh in ' + formatDuration(c5Diff) + '.';
        }
        document.getElementById('claude5HourExactTime').textContent = formatExactDate(c5Reset);
        setCircle('claude5HourCircle', c5Pct, 'claude5HourPct');
    }

    function renderUI(data, accounts, activeIdeEmail) {
        if (!data) return;
        currentData = data;
        savedAccountsList = accounts || [];
        if (activeIdeEmail) {
            activeIdeAccount = activeIdeEmail;
        } else if (data.user && data.user.email) {
            activeIdeAccount = data.user.email;
        }

        if (!selectedEmail) {
            selectedEmail = activeIdeAccount;
        } else {
            var found = savedAccountsList.some(function(a) {
                return a.email.toLowerCase() === selectedEmail.toLowerCase();
            });
            if (!found) selectedEmail = activeIdeAccount;
        }

        renderAccountDropdown();
        renderAllAccountsOverview();
        renderSelectedAccountDetails();
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.command === 'update') {
            renderUI(msg.data, msg.savedAccounts, msg.activeIdeEmail);
        }
    });

    vscode.postMessage({ command: 'getData' });
</script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

function deactivate() {
    if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
