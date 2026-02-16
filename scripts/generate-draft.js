const https = require('https');
const { execSync } = require('child_process');

// 環境変数
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

// アカウントコンセプトとプロンプト
const SYSTEM_PROMPT = `あなたは個人開発者「Kaito」のX（Twitter）投稿の下書きを作成するアシスタントです。

## 発信者プロフィール
- 個人でB2Cアプリケーションを開発している
- 現在「Annotune」というボーカル練習ノートアプリを開発・運用中
- 今後も音楽系に限らず様々なジャンルのサービスを開発予定
- 新しいサービスの企画と新しいツールを試すのが好き
- PdM（プロダクトマネージャー）的な動き方を志向
- ポジショニング: "思いついたら作る。あったらいいなを自分で形にするPdM兼エンジニア"

## 発信の3本柱
1. 企画の思考プロセス（メインコンテンツ・50%）
   - 日常の中で「こういうサービスあったらいいな」と気づく瞬間
   - 課題発見 → 解決策の着想 → 検証 → 開発決定までの思考の流れ
   - ユーザー視点でのプロダクト設計の考え方

2. 新ツール・新技術の実践レビュー（集客コンテンツ・30%）
   - 話題の開発ツールやサービスを実際に触ってみた感想
   - 個人開発で使えるかどうかの実践的な評価

3. リリース・改善の実績（収穫コンテンツ・20%）
   - 自分のサービスの新機能リリースや改善の報告
   - 「宣伝」ではなく「企画が形になった報告」というトーン
   - 数字やデータがあれば共有（PV、DL数など）

## トーン・文体
- カジュアルだけど知的好奇心が感じられるトーン
- 「〜してみた」「〜に気づいた」「〜が面白い」のような発見・体験ベースの語り口
- 断定的・教える口調ではなく、共有・つぶやきのスタンス
- 絵文字は控えめに使用（1投稿に0〜1個程度）
- ハッシュタグは基本的に不要（つけるとしても1つまで）
- 140字前後を目安に、長くても280字以内

## NGパターン（絶対に避けること）
- 「おはようございます！今日も頑張りましょう！」のような中身のない挨拶投稿
- 明らかに宣伝とわかるアプリ紹介
- AIが書いたとわかるような定型的・テンプレ的な文章
- 過度にポジティブ・意識高い系のトーン
- 他人を批判する内容`;

// 投稿タイプの重み付け
const POST_TYPES = [
  { type: 'idea', weight: 5, description: '企画の思考プロセス' },
  { type: 'tool', weight: 3, description: '新ツール・新技術の実践レビュー' },
  { type: 'release', weight: 2, description: 'リリース・改善の実績' }
];

// 重み付けランダム選択
function selectPostType() {
  const totalWeight = POST_TYPES.reduce((sum, p) => sum + p.weight, 0);
  let random = Math.random() * totalWeight;

  for (const postType of POST_TYPES) {
    random -= postType.weight;
    if (random <= 0) {
      return postType;
    }
  }
  return POST_TYPES[0];
}

// 直近のIssueを取得して重複テーマを避ける
function getRecentIssues() {
  try {
    const result = execSync(
      `gh issue list --limit 5 --state all --json title,body --repo ${GITHUB_REPOSITORY}`,
      { encoding: 'utf-8' }
    );
    return JSON.parse(result);
  } catch (error) {
    console.log('直近のIssue取得をスキップ:', error.message);
    return [];
  }
}

// Anthropic APIを呼び出す
function callAnthropicAPI(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: SYSTEM_PROMPT
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

// GitHub Issueを作成
function createIssue(title, body) {
  try {
    const result = execSync(
      `gh issue create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label "pending" --repo ${GITHUB_REPOSITORY}`,
      { encoding: 'utf-8' }
    );
    return result.trim();
  } catch (error) {
    throw new Error(`Issue作成失敗: ${error.message}`);
  }
}

// 投稿時刻を生成（昼12:00前後 or 夜19:00前後）
function generatePostTime(index) {
  const baseHours = index === 0 ? 12 : 19;
  const variance = Math.floor(Math.random() * 61) - 30; // -30〜+30分
  const minutes = variance;

  const hour = baseHours + Math.floor(minutes / 60);
  const min = ((minutes % 60) + 60) % 60;

  return `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
}

// メイン処理
async function main() {
  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEYが設定されていません');
    }

    // 直近のIssueを取得
    const recentIssues = getRecentIssues();
    const recentContext = recentIssues.length > 0
      ? `\n\n## 直近の投稿（テーマの重複を避けてください）\n${recentIssues.map(i => `- ${i.title}`).join('\n')}`
      : '';

    // 1〜2件の下書きを生成
    const numDrafts = Math.random() < 0.5 ? 1 : 2;
    console.log(`${numDrafts}件の下書きを生成します`);

    for (let i = 0; i < numDrafts; i++) {
      const postType = selectPostType();
      const postTime = generatePostTime(i);

      console.log(`\n[${i + 1}/${numDrafts}] ${postType.description}の下書きを生成中...`);

      const prompt = `以下の条件でX（Twitter）の投稿を1件だけ作成してください。

## 投稿タイプ
${postType.description}

## 投稿予定時刻
${postTime}（この時間帯に合った内容だとベター）
${recentContext}

## 出力形式
投稿本文のみを出力してください。説明や前置きは不要です。140字前後で、長くても280字以内。`;

      const draftContent = await callAnthropicAPI(prompt);

      // Issue作成
      const today = new Date().toISOString().split('T')[0];
      const title = `[${today} ${postTime}] ${postType.description}`;

      const issueBody = `<!-- 投稿内容を以下に記載してください（280文字以内推奨） -->

${draftContent.trim()}

---
投稿予定時刻: ${postTime}
カテゴリ: ${postType.description}
`;

      const issueUrl = createIssue(title, issueBody);
      console.log(`Issue作成完了: ${issueUrl}`);
    }

    console.log('\n下書き生成完了');
    process.exit(0);
  } catch (error) {
    console.error(`エラー: ${error.message}`);
    process.exit(1);
  }
}

main();
