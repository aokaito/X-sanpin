const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 環境変数
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

// プロンプトファイルの読み込み
function loadPrompt(agentName) {
  const promptPath = path.join(__dirname, '..', 'prompts', `${agentName}.md`);
  return fs.readFileSync(promptPath, 'utf-8');
}

// Anthropic API呼び出し
function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const response = JSON.parse(body);
          resolve(response.content[0].text);
        } else {
          reject(new Error(`Anthropic API Error (${res.statusCode}): ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 直近のIssueを取得
function getRecentIssues() {
  try {
    const result = execSync(
      `gh issue list --limit 5 --state all --json title,body,labels --repo ${GITHUB_REPOSITORY}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result);
  } catch (error) {
    console.log('直近のIssue取得をスキップ（初回実行の可能性）');
    return [];
  }
}

// GitHub Issue作成
function createIssue(title, body) {
  const escapedTitle = title.replace(/"/g, '\\"').replace(/`/g, '\\`');
  const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, '\\`');

  const result = execSync(
    `gh issue create --title "${escapedTitle}" --body "${escapedBody}" --label "pending" --repo ${GITHUB_REPOSITORY}`,
    { encoding: 'utf-8' }
  );
  return result.trim();
}

// JSONをパースする（コードブロックを除去）
function parseJSON(text) {
  // ```json ... ``` を除去
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// Agent 1: リサーチャー
async function runResearcher(recentIssues) {
  console.log('\n🔍 [Agent 1] リサーチャー起動...');

  const systemPrompt = loadPrompt('researcher');

  const issuesSummary = recentIssues.length > 0
    ? recentIssues.map(i => `- ${i.title}`).join('\n')
    : '（直近の投稿履歴なし - 初回実行）';

  const userMessage = `## 直近のIssue一覧（過去の投稿テーマ）

${issuesSummary}

今日の投稿テーマを提案してください。1〜2件のテーマをJSON形式で出力してください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('リサーチャー応答:', response.substring(0, 200) + '...');

  return parseJSON(response);
}

// Agent 2: ライター
async function runWriter(theme) {
  console.log(`\n✍️  [Agent 2] ライター起動... テーマ: ${theme.theme}`);

  const systemPrompt = loadPrompt('writer');

  const userMessage = `## 投稿テーマ

- カテゴリ: ${theme.category}
- テーマ: ${theme.theme}
- 切り口: ${theme.angle}
- 投稿予定時刻: ${theme.scheduledTime}

このテーマでKaitoとして自然な投稿を1件作成してください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('ライター応答:', response.substring(0, 100) + '...');

  return response.trim();
}

// Agent 3: エディター
async function runEditor(draft, theme) {
  console.log('\n📝 [Agent 3] エディター起動...');

  const systemPrompt = loadPrompt('editor');

  const userMessage = `## レビュー対象の投稿

カテゴリ: ${theme.category}
テーマ: ${theme.theme}

---

${draft}

---

この投稿をレビューしてください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('エディター応答:', response.substring(0, 200) + '...');

  return parseJSON(response);
}

// メイン処理
async function main() {
  console.log('=== X投稿下書き生成 Agent Teams ===\n');

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEYが設定されていません');
  }

  if (!GITHUB_REPOSITORY) {
    throw new Error('GITHUB_REPOSITORYが設定されていません');
  }

  // 直近のIssue取得
  const recentIssues = getRecentIssues();
  console.log(`直近のIssue: ${recentIssues.length}件`);

  // Agent 1: リサーチャー
  const researchResult = await runResearcher(recentIssues);
  console.log(`\n分析結果: ${researchResult.analysis}`);
  console.log(`提案テーマ数: ${researchResult.themes.length}件`);

  // 各テーマについて Agent 2 & 3 を実行
  for (let i = 0; i < researchResult.themes.length; i++) {
    const theme = researchResult.themes[i];
    console.log(`\n--- テーマ ${i + 1}/${researchResult.themes.length}: ${theme.theme} ---`);

    // Agent 2: ライター
    const draft = await runWriter(theme);

    // Agent 3: エディター
    const editResult = await runEditor(draft, theme);

    console.log(`\n編集結果:`);
    console.log(`  - 承認: ${editResult.approved ? 'OK' : 'NG'}`);
    console.log(`  - 文字数: ${editResult.charCount}字`);
    if (editResult.issues && editResult.issues.length > 0) {
      console.log(`  - 指摘事項: ${editResult.issues.join(', ')}`);
    }

    // Issue作成
    const today = new Date().toISOString().split('T')[0];
    const title = `[${today} ${theme.scheduledTime}] ${theme.category}`;

    const issueBody = `<!-- 投稿内容を以下に記載してください（280文字以内推奨） -->

${editResult.finalDraft}

---
**投稿予定時刻:** ${theme.scheduledTime}
**カテゴリ:** ${theme.category}
**テーマ:** ${theme.theme}
**文字数:** ${editResult.charCount}字
`;

    const issueUrl = createIssue(title, issueBody);
    console.log(`\n✅ Issue作成完了: ${issueUrl}`);
  }

  console.log('\n=== 全処理完了 ===');
}

main().catch((error) => {
  console.error(`\n❌ エラー: ${error.message}`);
  process.exit(1);
});
