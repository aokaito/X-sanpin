const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// 環境変数から認証情報を取得
const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;

// Issue本文から投稿内容を抽出
function extractTweetContent(issueBody) {
  if (!issueBody) {
    throw new Error('Issue本文が空です');
  }

  // HTMLコメントを除去し、前後の空白をトリム
  const content = issueBody
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (!content) {
    throw new Error('投稿内容が空です');
  }

  return content;
}

// OAuth 1.0a 署名を生成
function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams)
  ].join('&');

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  return crypto
    .createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');
}

// OAuth 1.0a ヘッダーを生成
function generateOAuthHeader(method, url) {
  const oauthParams = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0'
  };

  const signature = generateOAuthSignature(
    method,
    url,
    oauthParams,
    API_SECRET,
    ACCESS_TOKEN_SECRET
  );

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map(key => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

// X API v2でツイートを投稿
function postTweet(text) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.twitter.com/2/tweets';
    const data = JSON.stringify({ text });

    const options = {
      hostname: 'api.twitter.com',
      port: 443,
      path: '/2/tweets',
      method: 'POST',
      headers: {
        'Authorization': generateOAuthHeader('POST', url),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 201) {
          const response = JSON.parse(body);
          resolve(response);
        } else if (res.statusCode === 429) {
          reject(new Error('レート制限に達しました。しばらく待ってから再試行してください。'));
        } else {
          reject(new Error(`API Error (${res.statusCode}): ${body}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Request failed: ${e.message}`));
    });

    req.write(data);
    req.end();
  });
}

// メイン処理
async function main() {
  try {
    // 認証情報の確認
    if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
      throw new Error('X API認証情報が設定されていません');
    }

    // Issue本文から投稿内容を取得
    const issueBody = process.env.ISSUE_BODY;
    const tweetText = extractTweetContent(issueBody);

    console.log(`投稿内容: ${tweetText.substring(0, 50)}...`);

    // ツイートを投稿
    const result = await postTweet(tweetText);
    const tweetId = result.data.id;

    // ユーザー名を取得してURLを構築（ユーザー名は固定でも可）
    const tweetUrl = `https://x.com/i/status/${tweetId}`;

    console.log(`投稿成功: ${tweetUrl}`);

    // ツイートURLをファイルに保存（後続ステップで使用）
    fs.writeFileSync('tweet_url.txt', tweetUrl);

    process.exit(0);
  } catch (error) {
    console.error(`エラー: ${error.message}`);

    // エラー内容をファイルに保存（後続ステップで使用）
    fs.writeFileSync('error.txt', error.message);

    process.exit(1);
  }
}

main();
