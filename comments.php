<?php
/* Shared render comments for the light-rig scaler.
   Deployed next to index.html; the render board talks to it, and falls back to
   per-browser localStorage when this endpoint is unavailable.

   GET  -> {"<material>/<file>.png": {"text":"...","updated":"..."}, ...}
   POST {"key":"<material>/<file>.png","text":"..."} -> {"ok":true}
        (empty text deletes the key)

   Storage: render-comments.json next to this file — created on the first save.
   Deploy scripts must never overwrite render-comments.json. */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') { http_response_code(204); exit; }

$file = __DIR__ . '/render-comments.json';

if ($method === 'GET') {
  $raw = is_file($file) ? file_get_contents($file) : '';
  echo ($raw !== '' && $raw !== false) ? $raw : '{}';
  exit;
}

if ($method === 'POST') {
  $body = json_decode(file_get_contents('php://input'), true);
  $key  = (is_array($body) && isset($body['key'])  && is_string($body['key']))  ? trim($body['key']) : '';
  $text = (is_array($body) && isset($body['text']) && is_string($body['text'])) ? $body['text'] : null;
  if ($key === '' || strlen($key) > 512 || $text === null || strlen($text) > 4000) {
    http_response_code(400); echo '{"error":"expected {key, text}"}'; exit;
  }
  $fp = fopen($file, 'c+');
  if ($fp === false || !flock($fp, LOCK_EX)) {
    http_response_code(500); echo '{"error":"storage unavailable"}'; exit;
  }
  $raw = stream_get_contents($fp);
  $data = json_decode(($raw === false || $raw === '') ? '{}' : $raw, true);
  if (!is_array($data)) $data = array();
  if ($text === '') { unset($data[$key]); }
  else { $data[$key] = array('text' => $text, 'updated' => gmdate('Y-m-d\TH:i:s\Z')); }
  ftruncate($fp, 0);
  rewind($fp);
  fwrite($fp, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
  fflush($fp);
  flock($fp, LOCK_UN);
  fclose($fp);
  echo '{"ok":true}';
  exit;
}

http_response_code(405);
echo '{"error":"method not allowed"}';
