/**
 * X API 接続テストスクリプト
 *
 * 使い方:
 * X_API_KEY=xxx X_API_SECRET=xxx X_ACCESS_TOKEN=xxx X_ACCESS_TOKEN_SECRET=xxx node scripts/test-x-api.js
 */

const crypto = require('crypto');
const https = require('https');

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;

// 認証情報の確認
console.log('=== 認証情報チェック ===');
console.log(`API_KEY: ${API_KEY ? API_KEY.substring(0, 8) + '...' : '未設定'}`);
console.log(`API_SECRET: ${API_SECRET ? API_SECRET.substring(0, 8) + '...' : '未設定'}`);
console.log(`ACCESS_TOKEN: ${ACCESS_TOKEN ? ACCESS_TOKEN.substring(0, 8) + '...' : '未設定'}`);
console.log(`ACCESS_TOKEN_SECRET: ${ACCESS_TOKEN_SECRET ? ACCESS_TOKEN_SECRET.substring(0, 8) + '...' : '未設定'}`);

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('\n❌ 認証情報が不足しています');
  process.exit(1);
}

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

// テスト1: アカウント情報取得（読み取り権限テスト）
function testReadAccess() {
  return new Promise((resolve, reject) => {
    console.log('\n=== テスト1: アカウント情報取得 (GET /2/users/me) ===');

    const url = 'https://api.twitter.com/2/users/me';

    const options = {
      hostname: 'api.twitter.com',
      port: 443,
      path: '/2/users/me',
      method: 'GET',
      headers: {
        'Authorization': generateOAuthHeader('GET', url)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`ステータス: ${res.statusCode}`);
        console.log(`レスポンス: ${body}`);

        if (res.statusCode === 200) {
          const data = JSON.parse(body);
          console.log(`✅ 成功 - ユーザー名: @${data.data.username}`);
          resolve(data);
        } else {
          console.log('❌ 失敗');
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// テスト2: ツイート投稿（書き込み権限テスト）
function testWriteAccess() {
  return new Promise((resolve, reject) => {
    console.log('\n=== テスト2: ツイート投稿 (POST /2/tweets) ===');

    const url = 'https://api.twitter.com/2/tweets';
    const testMessage = `API接続テスト ${new Date().toISOString()}`;
    const data = JSON.stringify({ text: testMessage });

    console.log(`投稿内容: ${testMessage}`);

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
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`ステータス: ${res.statusCode}`);
        console.log(`レスポンス: ${body}`);

        if (res.statusCode === 201) {
          const result = JSON.parse(body);
          console.log(`✅ 成功 - ツイートID: ${result.data.id}`);
          console.log(`URL: https://x.com/i/status/${result.data.id}`);
          resolve(result);
        } else {
          console.log('❌ 失敗');

          // エラー詳細の解析
          try {
            const error = JSON.parse(body);
            if (error.status === 403) {
              console.log('\n--- 403エラーの考えられる原因 ---');
              console.log('1. アプリの権限が "Read and write" になっていない');
              console.log('2. Access Token が権限変更前に発行されたもの');
              console.log('3. X API Free プランの制限（v2 write access）');
              console.log('4. アカウントに制限がかかっている');
            }
          } catch (e) {}

          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('X API 接続テスト開始\n');

  // 読み取りテスト
  const readResult = await testReadAccess();

  if (!readResult) {
    console.log('\n読み取りテストが失敗しました。認証情報を確認してください。');
    process.exit(1);
  }

  // 書き込みテスト
  console.log('\n書き込みテストを実行しますか？（実際にツイートされます）');
  console.log('続行するには 5 秒待ちます... Ctrl+C でキャンセル');

  await new Promise(resolve => setTimeout(resolve, 5000));

  await testWriteAccess();

  console.log('\n=== テスト完了 ===');
}

main().catch(console.error);
