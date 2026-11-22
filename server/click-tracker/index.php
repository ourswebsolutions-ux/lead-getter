<?php
// Lead Finder click tracking (PHP 7.0+, any cPanel / shared hosting).
//
// Upload this file to a folder of your website, e.g. public_html/t/index.php,
// then in Lead Finder (Outreach > Email > Click tracking) enter the folder's
// address, e.g. https://yourdomain.com/t/ and press Connect.
//
//   GET  ?t=<id>&u=<url>&s=<signature>   a click: recorded, then the visitor is
//                                        sent on to the link (only links signed
//                                        by your Lead Finder are followed)
//   POST ?a=setup  key=...               pairs this file with your Lead Finder
//                                        (the first key is kept; later ones must match)
//   POST ?a=poll   key=... since=<ms>    the clicks recorded since then (JSON)
//
// Clicks are kept in ./data (created here, closed to the web) for 60 days.
// Nothing else is stored: no IP addresses, no cookies.

error_reporting(0);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');

$dir = __DIR__ . '/data';
$keyFile = $dir . '/key.php';
$logFile = $dir . '/clicks.php';
$GUARD = "<?php exit; ?>\n"; // the data files show nothing if opened in a browser
$KEEP_MS = 60 * 24 * 3600 * 1000;

function lf_json($code, $data) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data);
    exit;
}

function lf_b64url_decode($s) {
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    return base64_decode($s, true);
}

function lf_b64url($bin) {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function lf_key($keyFile, $GUARD) {
    if (!is_file($keyFile)) return null;
    $k = trim(substr((string) file_get_contents($keyFile), strlen($GUARD)));
    return $k === '' ? null : $k;
}

function lf_ensure_dir($dir) {
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return false;
    if (!is_file($dir . '/.htaccess')) @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    if (!is_file($dir . '/index.html')) @file_put_contents($dir . '/index.html', '');
    return is_writable($dir);
}

function lf_now_ms() {
    return (int) round(microtime(true) * 1000);
}

$a = isset($_GET['a']) ? $_GET['a'] : '';

// --- pairing and polling (Lead Finder only) ---------------------------------------
if ($a === 'setup' || $a === 'poll') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') lf_json(405, array('ok' => false, 'error' => 'POST only'));
    $given = isset($_POST['key']) ? (string) $_POST['key'] : '';
    if (strlen($given) < 32 || strlen($given) > 128) lf_json(400, array('ok' => false, 'error' => 'bad key'));
    if (!lf_ensure_dir($dir)) lf_json(500, array('ok' => false, 'error' => 'the data folder next to index.php cannot be created or written (check its permissions)'));
    $key = lf_key($keyFile, $GUARD);
    if ($key === null) {
        if ($a !== 'setup') lf_json(403, array('ok' => false, 'error' => 'not paired'));
        if (@file_put_contents($keyFile, $GUARD . $given . "\n", LOCK_EX) === false) lf_json(500, array('ok' => false, 'error' => 'the key cannot be saved'));
        @chmod($keyFile, 0600);
        $key = $given;
    }
    if (!hash_equals($key, $given)) lf_json(403, array('ok' => false, 'error' => 'paired with another Lead Finder: delete data/key.php on the server to pair again'));
    if ($a === 'setup') lf_json(200, array('ok' => true, 'app' => 'lead-finder-clicks', 'version' => 1, 'php' => PHP_VERSION));

    $since = isset($_POST['since']) ? (int) $_POST['since'] : 0;
    $out = array();
    if (is_file($logFile)) {
        $fh = fopen($logFile, 'r');
        if ($fh) {
            fgets($fh); // the guard line
            while (($line = fgets($fh)) !== false) {
                $c = json_decode($line, true);
                if (is_array($c) && isset($c['at']) && $c['at'] >= $since) $out[] = $c;
            }
            fclose($fh);
        }
    }
    if (count($out) > 5000) $out = array_slice($out, -5000);
    lf_json(200, array('ok' => true, 'clicks' => $out, 'now' => lf_now_ms()));
}

// --- a click -----------------------------------------------------------------------
$t = isset($_GET['t']) ? (string) $_GET['t'] : '';
$u = isset($_GET['u']) ? (string) $_GET['u'] : '';
$s = isset($_GET['s']) ? (string) $_GET['s'] : '';
$key = lf_key($keyFile, $GUARD);
$url = lf_b64url_decode($u);
$valid = $key !== null && preg_match('/^[A-Za-z0-9_-]{4,40}$/', $t) && $url !== false && preg_match('#^https?://#i', $url)
    && hash_equals(substr(lf_b64url(hash_hmac('sha256', $t . '|' . $u, $key, true)), 0, 22), $s);

if (!$valid) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Link not found.";
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && lf_ensure_dir($dir)) {
    $now = lf_now_ms();
    $ua = isset($_SERVER['HTTP_USER_AGENT']) ? substr((string) $_SERVER['HTTP_USER_AGENT'], 0, 200) : '';
    $id = sprintf('%013d-%s', $now, bin2hex(function_exists('random_bytes') ? random_bytes(4) : substr(md5(uniqid('', true)), 0, 4)));
    $row = json_encode(array('id' => $id, 't' => $t, 'u' => $url, 'at' => $now, 'ua' => $ua)) . "\n";
    $fh = @fopen($logFile, 'c+');
    if ($fh && flock($fh, LOCK_EX)) {
        $size = fstat($fh)['size'];
        if ($size === 0) fwrite($fh, $GUARD);
        // Older than 60 days: dropped now and then (the file stays small).
        if ($size > 2 * 1024 * 1024) {
            rewind($fh);
            fgets($fh);
            $keep = array();
            while (($line = fgets($fh)) !== false) {
                $c = json_decode($line, true);
                if (is_array($c) && isset($c['at']) && $c['at'] >= $now - $KEEP_MS) $keep[] = $line;
            }
            $keep = array_slice($keep, -20000);
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, $GUARD . implode('', $keep));
        }
        fseek($fh, 0, SEEK_END);
        fwrite($fh, $row);
        fflush($fh);
        flock($fh, LOCK_UN);
    }
    if ($fh) fclose($fh);
    @chmod($logFile, 0600);
}

header('Location: ' . $url, true, 302);
exit;
