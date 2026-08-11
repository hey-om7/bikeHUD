/*
 * web_portal.h - HTML/CSS/JS for WiFi config captive portal
 * Professional, clean mobile-first UI
 */
#ifndef WEB_PORTAL_H
#define WEB_PORTAL_H

const char PORTAL_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tripper Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(20px);
border:1px solid rgba(255,255,255,0.1);border-radius:24px;
padding:40px 32px;width:100%;max-width:380px;
box-shadow:0 25px 50px rgba(0,0,0,0.3)}
.logo{text-align:center;margin-bottom:28px}
.logo h1{color:#fff;font-size:24px;font-weight:700;letter-spacing:1px}
.logo p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:6px}
.form-group{margin-bottom:20px}
.form-group label{display:block;color:rgba(255,255,255,0.7);
font-size:12px;font-weight:600;text-transform:uppercase;
letter-spacing:0.8px;margin-bottom:8px}
.form-group input{width:100%;padding:14px 16px;
background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
border-radius:12px;color:#fff;font-size:15px;
transition:all 0.3s ease;outline:none}
.form-group input:focus{border-color:#ff8c00;
background:rgba(255,140,0,0.05);box-shadow:0 0 0 3px rgba(255,140,0,0.1)}
.form-group input::placeholder{color:rgba(255,255,255,0.3)}
.btn{width:100%;padding:16px;background:linear-gradient(135deg,#ff8c00,#ff6b00);
border:none;border-radius:12px;color:#fff;font-size:16px;
font-weight:600;cursor:pointer;transition:all 0.3s ease;
letter-spacing:0.5px;margin-top:8px}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(255,140,0,0.3)}
.btn:active{transform:translateY(0)}
.status{text-align:center;margin-top:20px;padding:12px;
border-radius:10px;font-size:13px;display:none}
.status.show{display:block}
.status.success{background:rgba(43,224,48,0.15);color:#2be030;
border:1px solid rgba(43,224,48,0.3)}
.status.error{background:rgba(216,0,0,0.15);color:#ff6b6b;
border:1px solid rgba(216,0,0,0.3)}
.status.loading{background:rgba(45,175,255,0.15);color:#2dafff;
border:1px solid rgba(45,175,255,0.3)}
.divider{height:1px;background:rgba(255,255,255,0.08);margin:24px 0}
.info{text-align:center;color:rgba(255,255,255,0.4);font-size:11px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<div class="logo">
<h1>TRIPPER</h1>
<p>Motorcycle Telemetry System</p>
</div>
<form id="wifiForm">
<div class="form-group">
<label>WiFi Network Name</label>
<input type="text" id="ssid" name="ssid" placeholder="Enter your hotspot SSID" required autocomplete="off">
</div>
<div class="form-group">
<label>Password</label>
<input type="password" id="pass" name="pass" placeholder="Enter WiFi password" required>
</div>
<button type="submit" class="btn">Connect</button>
</form>
<div id="status" class="status"></div>
<div class="divider"></div>
<div class="info">
Enter your mobile hotspot credentials.<br>
Tripper will connect and begin telemetry.
</div>
</div>
<script>
document.getElementById('wifiForm').addEventListener('submit',function(e){
e.preventDefault();
var s=document.getElementById('status');
s.className='status show loading';
s.textContent='Connecting...';
var ssid=document.getElementById('ssid').value;
var pass=document.getElementById('pass').value;
fetch('/connect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
body:'ssid='+encodeURIComponent(ssid)+'&pass='+encodeURIComponent(pass)})
.then(function(r){return r.json()})
.then(function(d){
if(d.success){s.className='status show success';s.textContent='Connected! Tripper is starting...';}
else{s.className='status show error';s.textContent='Failed: '+d.message;}
}).catch(function(){s.className='status show error';s.textContent='Connection error. Try again.';});
});
</script>
</body>
</html>
)rawliteral";

#endif // WEB_PORTAL_H
