const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 環境変数
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const SCHEDULED_TIME = process.env.SCHEDULED_TIME || '12:00';

// プロンプトファイルの読み込み
function loadPrompt(agentName) {
  const promptPath = path.join(__dirname, '..', 'prompts', `${agentName}.md`);
  return fs.readFileSync(promptPath, 'utf-8');
}

// フィードバック履歴の読み込み
function loadFeedback() {
  const feedbackPath = path.join(__dirname, '..', 'knowledge', 'feedback-log.json');
  try {
    const data = fs.readFileSync(feedbackPath, 'utf-8');
    const feedback = JSON.parse(data);
    // 直近10件のみ返す
    return feedback.entries.slice(-10);
  } catch (error) {
    console.log('フィードバック履歴なし（初回実行の可能性）');
    return [];
  }
}

// ナレッジの読み込み
function loadKnowledge() {
  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  const knowledge = {};

  const files = ['guidelines.md', 'ng-patterns.md', 'good-examples.md'];
  for (const file of files) {
    const filePath = path.join(knowledgeDir, file);
    try {
      knowledge[file.replace('.md', '')] = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      // ファイルがない場合はスキップ
    }
  }

  return knowledge;
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

// Annotuneの最近の変更を取得
function getAnnotuneRecentChanges() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: '/repos/aokaito/annotune/commits?per_page=7',
      method: 'GET',
      headers: {
        'User-Agent': 'X-sanpin-bot',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const commits = JSON.parse(body);
            const summary = commits.map(c =>
              `- ${c.commit.message.split('\n')[0]} (${c.commit.author.date.split('T')[0]})`
            ).join('\n');
            resolve(summary);
          } catch (e) {
            resolve(null);
          }
        } else {
          console.log(`Annotune GitHub API: ${res.statusCode}`);
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.end();
  });
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

// JSONをパースする（コードブロックを除去し、JSON部分のみ抽出）
function parseJSON(text) {
  // ```json ... ``` を除去
  let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // JSON オブジェクトを抽出（最初の { から対応する } まで）
  const startIndex = cleaned.indexOf('{');
  if (startIndex === -1) {
    throw new Error('JSONが見つかりません: ' + cleaned.substring(0, 100));
  }

  let braceCount = 0;
  let endIndex = -1;
  for (let i = startIndex; i < cleaned.length; i++) {
    if (cleaned[i] === '{') braceCount++;
    if (cleaned[i] === '}') braceCount--;
    if (braceCount === 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error('JSONの終端が見つかりません');
  }

  const jsonStr = cleaned.substring(startIndex, endIndex + 1);
  return JSON.parse(jsonStr);
}

// Agent 1: リサーチャー
async function runResearcher(recentIssues, scheduledTime, annotuneChanges) {
  console.log('\n🔍 [Agent 1] リサーチャー起動...');

  const systemPrompt = loadPrompt('researcher');

  const issuesSummary = recentIssues.length > 0
    ? recentIssues.map(i => `- ${i.title}`).join('\n')
    : '（直近の投稿履歴なし - 初回実行）';

  const annotuneContext = annotuneChanges
    ? `\n\n## Annotuneの最近の変更履歴\n${annotuneChanges}`
    : '';

  const userMessage = `## 直近のIssue一覧（過去の投稿テーマ）

${issuesSummary}

## 今日の投稿設定
- 投稿予定時刻: **${scheduledTime}**${annotuneContext}

今日の投稿テーマを **1件のみ** 提案してください。JSON形式で出力してください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('リサーチャー応答:', response.substring(0, 200) + '...');

  return parseJSON(response);
}

// Agent 2: ストラテジスト
async function runStrategist(researchResult, feedbackEntries, knowledge) {
  console.log('\n📊 [Agent 2] ストラテジスト起動...');

  const systemPrompt = loadPrompt('strategist');

  // フィードバック履歴のサマリーを作成
  let feedbackSummary = '（フィードバック履歴なし - 初回または蓄積前）';
  if (feedbackEntries.length > 0) {
    feedbackSummary = feedbackEntries.map(entry => {
      let summary = `- [${entry.date}] ${entry.category}: `;
      if (entry.wasModified) {
        summary += `修正あり（理由: ${entry.feedbackReason || '未記載'}）`;
      } else {
        summary += '修正なしで承認';
      }
      return summary;
    }).join('\n');
  }

  // ナレッジのサマリーを作成
  let knowledgeSummary = '';
  if (knowledge.guidelines) {
    knowledgeSummary += `\n### ガイドライン\n${knowledge.guidelines.substring(0, 500)}...\n`;
  }
  if (knowledge['ng-patterns']) {
    knowledgeSummary += `\n### NGパターン\n${knowledge['ng-patterns'].substring(0, 500)}...\n`;
  }
  if (knowledge['good-examples']) {
    knowledgeSummary += `\n### 良い投稿例\n${knowledge['good-examples'].substring(0, 500)}...\n`;
  }

  const theme = researchResult.themes[0];
  const userMessage = `## リサーチャーの分析結果

${researchResult.analysis}

## 提案されたテーマ

- カテゴリ: ${theme.category}
- テーマ: ${theme.theme}
- 切り口: ${theme.angle}
- 投稿予定時刻: ${theme.scheduledTime}

## フィードバック履歴（直近の修正状況）

${feedbackSummary}

## ナレッジ
${knowledgeSummary}

このテーマに対する投稿戦略を立案してください。JSON形式で出力してください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('ストラテジスト応答:', response.substring(0, 200) + '...');

  return parseJSON(response);
}

// Agent 3: ライター
async function runWriter(theme, annotuneChanges, strategy) {
  console.log(`\n✍️  [Agent 3] ライター起動... テーマ: ${theme.theme}`);

  const systemPrompt = loadPrompt('writer');

  const annotuneContext = annotuneChanges
    ? `\n\n## Annotuneの最近の変更（Annotune関連の投稿を作る場合は必ずここから事実を参照してください）\n${annotuneChanges}`
    : '';

  // ストラテジストからの指示を追加
  let strategyContext = '';
  if (strategy) {
    strategyContext = `\n\n## ストラテジストからの指示

### 今回の戦略
${strategy.strategyForTheme || ''}

### 具体的な指示
${(strategy.writerInstructions || []).map(i => `- ${i}`).join('\n')}

### 避けるべきパターン
${(strategy.avoidPatterns || []).map(p => `- ${p}`).join('\n')}`;
  }

  const userMessage = `## 投稿テーマ

- カテゴリ: ${theme.category}
- テーマ: ${theme.theme}
- 切り口: ${theme.angle}
- 投稿予定時刻: ${theme.scheduledTime}${strategyContext}${annotuneContext}

このテーマでKaitoとして自然な投稿を1件作成してください。`;

  const response = await callClaude(systemPrompt, userMessage);
  console.log('ライター応答:', response.substring(0, 100) + '...');

  return response.trim();
}

// Agent 4: エディター
async function runEditor(draft, theme, strategy) {
  console.log('\n📝 [Agent 4] エディター起動...');

  const systemPrompt = loadPrompt('editor');

  // ストラテジストからのチェックポイントを追加
  let strategyContext = '';
  if (strategy && strategy.editorCheckpoints) {
    strategyContext = `\n\n## ストラテジストからの特別チェックポイント
${strategy.editorCheckpoints.map(c => `- ${c}`).join('\n')}`;
  }

  const userMessage = `## レビュー対象の投稿

カテゴリ: ${theme.category}
テーマ: ${theme.theme}${strategyContext}

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
  console.log('=== X投稿下書き生成 Agent Teams (4Agent) ===\n');
  console.log(`投稿予定時刻: ${SCHEDULED_TIME}`);

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEYが設定されていません');
  }

  if (!GITHUB_REPOSITORY) {
    throw new Error('GITHUB_REPOSITORYが設定されていません');
  }

  // 直近のIssue取得、Annotune最近の変更、フィードバック、ナレッジを並行取得
  const [recentIssues, annotuneChanges] = await Promise.all([
    Promise.resolve(getRecentIssues()),
    getAnnotuneRecentChanges()
  ]);
  const feedbackEntries = loadFeedback();
  const knowledge = loadKnowledge();

  console.log(`直近のIssue: ${recentIssues.length}件`);
  console.log(`Annotune最近の変更: ${annotuneChanges ? '取得成功' : '取得失敗（スキップ）'}`);
  console.log(`フィードバック履歴: ${feedbackEntries.length}件`);
  console.log(`ナレッジ: ${Object.keys(knowledge).length}ファイル`);

  // Agent 1: リサーチャー
  const researchResult = await runResearcher(recentIssues, SCHEDULED_TIME, annotuneChanges);
  console.log(`\n分析結果: ${researchResult.analysis}`);
  console.log(`提案テーマ数: ${researchResult.themes.length}件`);

  // Agent 2: ストラテジスト
  const strategy = await runStrategist(researchResult, feedbackEntries, knowledge);
  console.log(`\n戦略: ${strategy.strategyForTheme || ''}`);

  // 各テーマについて Agent 3 & 4 を実行
  for (let i = 0; i < researchResult.themes.length; i++) {
    const theme = researchResult.themes[i];
    console.log(`\n--- テーマ ${i + 1}/${researchResult.themes.length}: ${theme.theme} ---`);

    // Agent 3: ライター
    const draft = await runWriter(theme, annotuneChanges, strategy);

    // Agent 4: エディター
    const editResult = await runEditor(draft, theme, strategy);

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

---
## フィードバック記録（修正時に記入）

### 修正前
<!-- 修正した場合、元の投稿内容をここに記載してください -->

### 修正理由
<!-- なぜ修正したのかを記載してください（例：もう少しカジュアルに、具体例を追加、など） -->
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
