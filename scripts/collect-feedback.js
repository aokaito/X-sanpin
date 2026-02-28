const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 環境変数
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

// フィードバックログのパス
const FEEDBACK_LOG_PATH = path.join(__dirname, '..', 'knowledge', 'feedback-log.json');

// Issue本文からフィードバック情報を抽出
function extractFeedbackFromIssue(issueBody) {
  const result = {
    originalDraft: null,
    finalDraft: null,
    feedbackReason: null,
    wasModified: false
  };

  // 投稿内容（最終版）を抽出
  // <!-- ... --> から --- までの部分
  const contentMatch = issueBody.match(/<!--[^>]*-->\s*([\s\S]*?)(?=\n---)/);
  if (contentMatch) {
    result.finalDraft = contentMatch[1].trim();
  }

  // 修正前セクションを抽出
  const originalMatch = issueBody.match(/### 修正前\s*\n(?:<!--[^>]*-->\s*)?\n?([\s\S]*?)(?=\n### 修正理由)/);
  if (originalMatch) {
    const original = originalMatch[1].trim();
    // HTMLコメントのみでない場合は修正があったとみなす
    if (original && !original.startsWith('<!--') && original.length > 0) {
      result.originalDraft = original;
      result.wasModified = true;
    }
  }

  // 修正理由セクションを抽出
  const reasonMatch = issueBody.match(/### 修正理由\s*\n(?:<!--[^>]*-->\s*)?\n?([\s\S]*?)$/);
  if (reasonMatch) {
    const reason = reasonMatch[1].trim();
    // HTMLコメントのみでない場合
    if (reason && !reason.startsWith('<!--') && reason.length > 0) {
      result.feedbackReason = reason;
    }
  }

  return result;
}

// Issueのメタデータを抽出
function extractMetadata(issueBody) {
  const metadata = {
    scheduledTime: null,
    category: null,
    theme: null,
    charCount: null
  };

  const timeMatch = issueBody.match(/\*\*投稿予定時刻:\*\*\s*(\S+)/);
  if (timeMatch) metadata.scheduledTime = timeMatch[1];

  const categoryMatch = issueBody.match(/\*\*カテゴリ:\*\*\s*(.+)/);
  if (categoryMatch) metadata.category = categoryMatch[1].trim();

  const themeMatch = issueBody.match(/\*\*テーマ:\*\*\s*(.+)/);
  if (themeMatch) metadata.theme = themeMatch[1].trim();

  const charMatch = issueBody.match(/\*\*文字数:\*\*\s*(\d+)/);
  if (charMatch) metadata.charCount = parseInt(charMatch[1], 10);

  return metadata;
}

// フィードバックログを読み込む
function loadFeedbackLog() {
  try {
    const data = fs.readFileSync(FEEDBACK_LOG_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.log('フィードバックログを新規作成します');
    return { entries: [], lastUpdated: null };
  }
}

// フィードバックログを保存
function saveFeedbackLog(log) {
  log.lastUpdated = new Date().toISOString();
  fs.writeFileSync(FEEDBACK_LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// Issue情報を取得
function getIssue(issueNumber) {
  try {
    const result = execSync(
      `gh issue view ${issueNumber} --json title,body,labels,createdAt,closedAt --repo ${GITHUB_REPOSITORY}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result);
  } catch (error) {
    console.error(`Issue取得エラー: ${error.message}`);
    return null;
  }
}

// メイン処理
async function main() {
  console.log('=== フィードバック収集 ===\n');

  if (!ISSUE_NUMBER) {
    throw new Error('ISSUE_NUMBERが設定されていません');
  }

  if (!GITHUB_REPOSITORY) {
    throw new Error('GITHUB_REPOSITORYが設定されていません');
  }

  console.log(`Issue #${ISSUE_NUMBER} を処理中...`);

  // Issue情報を取得
  const issue = getIssue(ISSUE_NUMBER);
  if (!issue) {
    throw new Error('Issueの取得に失敗しました');
  }

  console.log(`タイトル: ${issue.title}`);

  // フィードバック情報を抽出
  const feedback = extractFeedbackFromIssue(issue.body);
  const metadata = extractMetadata(issue.body);

  console.log(`修正あり: ${feedback.wasModified ? 'はい' : 'いいえ'}`);

  // フィードバックログを更新
  const log = loadFeedbackLog();

  // 同じIssue番号のエントリがあれば更新、なければ追加
  const existingIndex = log.entries.findIndex(e => e.issueNumber === parseInt(ISSUE_NUMBER, 10));

  const entry = {
    issueNumber: parseInt(ISSUE_NUMBER, 10),
    title: issue.title,
    date: issue.createdAt.split('T')[0],
    postedAt: issue.closedAt,
    category: metadata.category,
    theme: metadata.theme,
    scheduledTime: metadata.scheduledTime,
    originalDraft: feedback.originalDraft,
    finalDraft: feedback.finalDraft,
    feedbackReason: feedback.feedbackReason,
    wasModified: feedback.wasModified,
    charCount: metadata.charCount
  };

  if (existingIndex >= 0) {
    log.entries[existingIndex] = entry;
    console.log(`既存エントリを更新しました`);
  } else {
    log.entries.push(entry);
    console.log(`新規エントリを追加しました`);
  }

  // 最新30件のみ保持
  if (log.entries.length > 30) {
    log.entries = log.entries.slice(-30);
    console.log(`エントリ数を30件に制限しました`);
  }

  saveFeedbackLog(log);
  console.log(`\nフィードバックログを保存しました: ${FEEDBACK_LOG_PATH}`);

  // サマリー出力
  console.log('\n--- サマリー ---');
  console.log(`カテゴリ: ${entry.category}`);
  console.log(`テーマ: ${entry.theme}`);
  console.log(`修正: ${entry.wasModified ? 'あり' : 'なし'}`);
  if (entry.feedbackReason) {
    console.log(`修正理由: ${entry.feedbackReason}`);
  }
}

main().catch((error) => {
  console.error(`\nエラー: ${error.message}`);
  process.exit(1);
});
