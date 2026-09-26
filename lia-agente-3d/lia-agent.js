/*!
 * LIA · Agente 3D da Liame  —  v1.4
 * Requer three.js r147 (build/three.min.js) carregado antes deste arquivo.
 * Opcional: examples/js/controls/OrbitControls.js e examples/js/environments/RoomEnvironment.js
 *
 * Uso:
 *   const lia = LiaAgent.create(document.getElementById('lia'), { framing:'full', background:'transparent' });
 *   lia.setState('wave');               // muda a expressão
 *   lia.react('happy', 2500);           // expressão temporária, volta para 'idle'
 *   lia.setColors({ hair:'#1E63F0' });  // troca cores
 *   lia.setOutfit('auto');              // visual da estação/data de hoje (Brasil)
 */
(function (global) {
  'use strict';

  var STATE_LIST = [
    ['idle', 'Parada'], ['wave', 'Olá'], ['talk', 'Falando'], ['listen', 'Ouvindo'], ['think', 'Pensando'],
    ['working', 'Trabalhando'], ['analyze', 'Analisando'], ['happy', 'Feliz'], ['celebrate', 'Comemorando'],
    ['love', 'Encantada'], ['wink', 'Piscadinha'], ['surprised', 'Surpresa'], ['confused', 'Confusa'],
    ['empathetic', 'Empática'], ['shy', 'Tímida']
  ];

  var PRESETS = {
    liame:     { hair: '#1E63F0', skin: '#E8A47E', eyes: '#2a5fe0', suit: '#1E2550', skirt: '#1E2550', shirt: '#F7F8FC', accent: '#2DD4DE', set: '#23263A', shoes: '#14141F' },
    classica:  { hair: '#2A1712', skin: '#EFB996', eyes: '#8B5A2B', suit: '#111111', skirt: '#111111', shirt: '#F7F8FC', accent: '#FF3B3B', set: '#C0C4CC', shoes: '#14141F' },
    vibrante:  { hair: '#E0407A', skin: '#E8A47E', eyes: '#10A8E0', suit: '#2F7BFF', skirt: '#2F7BFF', shirt: '#FFF3B0', accent: '#FFC24B', set: '#F4F2EC', shoes: '#F4F2EC' },
    pastel:    { hair: '#B9A8FF', skin: '#F6D2BC', eyes: '#7B3FE4', suit: '#F7B6C8', skirt: '#DDEBFF', shirt: '#F7F8FC', accent: '#7B61FF', set: '#F4F2EC', shoes: '#F4F2EC' },
    tropical:  { hair: '#F07830', skin: '#C98460', eyes: '#2EC27E', suit: '#0F5E57', skirt: '#0F5E57', shirt: '#FFE9D6', accent: '#39D98A', set: '#F4F2EC', shoes: '#6B4226' },
    noturna:   { hair: '#7B3FE4', skin: '#A5683F', eyes: '#E0407A', suit: '#111111', skirt: '#111111', shirt: '#1B1B1B', accent: '#FF4FA3', set: '#111111', shoes: '#14141F' },
    vinho:     { hair: '#1B1830', skin: '#E8A47E', eyes: '#8B5A2B', suit: '#8B1E3F', skirt: '#2A2D38', shirt: '#FFE9D6', accent: '#FFC24B', set: '#2A2D38', shoes: '#8B1E3F' }
  };

  // ---------------- calendário (hemisfério sul, Brasil)
  function easter(y) { var a = y % 19, b = Math.floor(y/100), c = y % 100, d = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25), g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15) % 30, i = Math.floor(c/4), k = c % 4, l = (32+2*e+2*i-h-k) % 7, mm = Math.floor((a+11*h+22*l)/451), mo = Math.floor((h+l-7*mm+114)/31), da = ((h+l-7*mm+114) % 31) + 1; return new Date(y, mo-1, da); }
  function dayDiff(a, b) { return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()))/864e5); }
  function outfitForDate(dt, onlySeason) {
    dt = dt ? new Date(dt) : new Date(); var y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate(), md = mo*100 + d;
    if (!onlySeason) {
      var ea = easter(y), carn = new Date(ea); carn.setDate(ea.getDate() - 47);
      var dc = dayDiff(dt, carn); if (dc >= -5 && dc <= 1) return 'carnaval';
      var de = dayDiff(dt, ea); if (de >= -6 && de <= 0) return 'pascoa';
      if (md >= 605 && md <= 612) return 'namorados';
      if (md >= 601 && md <= 720) return 'junina';
      if (md >= 1024 && md <= 1031) return 'halloween';
      var nov1 = new Date(y, 10, 1), bf = new Date(y, 10, 1 + ((5 - nov1.getDay() + 7) % 7) + 21), db = dayDiff(dt, bf); if (db >= -4 && db <= 3) return 'blackfriday';
      if (md >= 1201 && md <= 1226) return 'natal';
      if (md >= 1227 || md <= 102) return 'anonovo';
    }
    if (md >= 1221 || md < 320) return 'verao';
    if (md < 621) return 'outono';
    if (md < 923) return 'inverno';
    return 'primavera';
  }
  var OUTFIT_LIST = [
    ['executiva','Executiva','base','o ano todo'], ['verao','Verão','estacao','21 dez a 19 mar'], ['outono','Outono','estacao','20 mar a 20 jun'], ['inverno','Inverno','estacao','21 jun a 22 set'], ['primavera','Primavera','estacao','23 set a 20 dez'],
    ['carnaval','Carnaval','data','semana do Carnaval'], ['pascoa','Páscoa','data','semana da Páscoa'], ['namorados','Dia dos Namorados','data','5 a 12 jun'], ['junina','Festa Junina','data','junho a 20 jul'], ['torcida','Torcida Brasil','data','jogos da Seleção (manual)'],
    ['halloween','Halloween','data','24 a 31 out'], ['blackfriday','Black Friday','data','semana da Black Friday'], ['natal','Natal','data','1 a 26 dez'], ['anonovo','Ano Novo','data','27 dez a 2 jan']
  ];

  var FRAMING = {
    full: { target: [0, 0.75, 0], pos: [1.6, 1.4, 9], narrow: 11 },
    bust: { target: [0, 1.25, 0], pos: [0.8, 1.55, 5.2], narrow: 6 },
    face: { target: [0, 1.45, 0], pos: [0.3, 1.55, 3.6], narrow: 3.9 }
  };

  function create(container, opts) {
    var THREE = global.THREE;
    opts = Object.assign({
      framing: 'full',            // 'full' | 'bust' | 'face'
      background: 'transparent',  // 'transparent' ou qualquer cor CSS (ex.: '#F1EEEA')
      controls: true,             // arrastar para girar (precisa do OrbitControls)
      zoom: true,                 // rodinha do mouse aproxima
      shadows: true,
      floorRing: true,            // anel de luz no chão
      lookAtPointer: true,        // olhar segue o cursor
      outfit: 'executiva',        // visual: id, ou 'auto' (estação/data de hoje)
      state: 'idle',
      colors: 'liame',            // nome de preset ou objeto de cores
      capture: false,             // true permite snapshot() e gravação de vídeo
      pixelRatio: Math.min(global.devicePixelRatio || 1, 2),
      reducedMotion: global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
      pauseWhenHidden: true
    }, opts || {});
    if (!THREE) throw new Error('LiaAgent: carregue o three.js r147 antes de lia-agent.js');

    var listeners = {};
    function emit(ev, data) { (listeners[ev] || []).forEach(function (f) { try { f(data); } catch (e) { console.error(e); } }); }

    // ---------------- renderer / scene
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.capture });
    renderer.setPixelRatio(opts.pixelRatio);
    if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false; // cores hex tratadas como sRGB (sem aspecto lavado)
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = !!opts.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (opts.background && opts.background !== 'transparent') renderer.setClearColor(new THREE.Color(opts.background), 1);
    else renderer.setClearColor(0x000000, 0);
    var canvas = renderer.domElement;
    canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'LIA, assistente virtual da Liame');
    container.appendChild(canvas);

    var scene = new THREE.Scene();
    var ENV = null;
    if (THREE.RoomEnvironment) { var pm = new THREE.PMREMGenerator(renderer); ENV = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture; }
    var camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    var controls = null;
    if (opts.controls && THREE.OrbitControls) {
      controls = new THREE.OrbitControls(camera, canvas);
      controls.enablePan = false; controls.enableDamping = true; controls.enableZoom = !!opts.zoom;
      controls.minDistance = 2.5; controls.maxDistance = 14; controls.minPolarAngle = .85; controls.maxPolarAngle = 1.85;
    }
    scene.add(new THREE.HemisphereLight(0xfffaf2, 0x8a7a6a, .55));
    var key = new THREE.DirectionalLight(0xfff3e6, 1.35); key.position.set(4, 7, 6);
    key.castShadow = !!opts.shadows; key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 4; key.shadow.camera.bottom = -3; key.shadow.bias = -.0006;
    scene.add(key);
    var fillL = new THREE.DirectionalLight(0xfff8f0, .3); fillL.position.set(-5, 3, 4); scene.add(fillL);
    var rimL = new THREE.DirectionalLight(0xffffff, .45); rimL.position.set(0, 4, -6); scene.add(rimL);

    function mat(c, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .7, envMap: ENV, envMapIntensity: .12 }, o || {})); }
    var glow = mat(0x2DD4DE, { emissive: 0x2DD4DE, emissiveIntensity: .6, roughness: .3 });
    var micGlow = mat(0x2DD4DE, { emissive: 0x2DD4DE, emissiveIntensity: .8, roughness: .3 });
    if (opts.shadows) {
      var floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: .28 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -1.41; floor.receiveShadow = true; scene.add(floor);
    }

    // ---------------- helpers & textures
    var BS = new THREE.Shape();
    (function () { var w = .5, h = .38, r = .1; BS.moveTo(-w/2+r, h/2); BS.lineTo(w/2-r, h/2); BS.quadraticCurveTo(w/2, h/2, w/2, h/2-r); BS.lineTo(w/2, -h/2+r); BS.quadraticCurveTo(w/2, -h/2, w/2-r, -h/2); BS.lineTo(-w*.08, -h/2); BS.lineTo(-w*.3, -h/2-.14); BS.lineTo(-w*.3, -h/2); BS.lineTo(-w/2+r, -h/2); BS.quadraticCurveTo(-w/2, -h/2, -w/2, -h/2+r); BS.lineTo(-w/2, h/2-r); BS.quadraticCurveTo(-w/2, h/2, -w/2+r, h/2); })();
    function bubbleGeo(d) { return new THREE.ExtrudeGeometry(BS, { depth: d, bevelEnabled: true, bevelThickness: .035, bevelSize: .035, bevelSegments: 3 }); }
    var HS = new THREE.Shape();
    HS.moveTo(0, -.35); HS.bezierCurveTo(-.55, -.02, -.5, .42, -.2, .42); HS.bezierCurveTo(-.08, .42, 0, .32, 0, .22); HS.bezierCurveTo(0, .32, .08, .42, .2, .42); HS.bezierCurveTo(.5, .42, .55, -.02, 0, -.35);
    function canvasTex(w, h, draw) { var c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); var t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t; }
    function drawL(x, cx, cy, s, col, node) { x.strokeStyle = col; x.lineWidth = s*.22; x.lineCap = 'butt'; x.beginPath(); x.moveTo(cx-s*.35, cy-s*.5); x.lineTo(cx-s*.35, cy+s*.35); x.lineTo(cx+s*.12, cy+s*.35); x.stroke(); x.fillStyle = node; x.beginPath(); x.arc(cx+s*.35, cy+s*.35, s*.12, 0, 7); x.fill(); x.fillRect(cx-s*.46, cy+s*.56, s*.92, s*.07); }
    function makeIris(hex) {
      var c = new THREE.Color(hex), W = new THREE.Color(0xffffff);
      var hi = '#' + c.clone().lerp(W, .65).getHexString(), mid = '#' + c.getHexString(), lo = '#' + c.clone().multiplyScalar(.35).getHexString();
      return canvasTex(256, 256, function (x) {
        var g = x.createRadialGradient(128, 150, 20, 128, 128, 128); g.addColorStop(0, hi); g.addColorStop(.4, mid); g.addColorStop(.85, lo); g.addColorStop(1, '#0a0a18');
        x.fillStyle = g; x.beginPath(); x.arc(128, 128, 128, 0, 7); x.fill();
        x.fillStyle = 'rgba(0,0,20,.35)'; x.beginPath(); x.ellipse(128, 70, 110, 60, 0, 0, 7); x.fill();
        x.fillStyle = '#08081a'; x.beginPath(); x.ellipse(128, 132, 40, 52, 0, 0, 7); x.fill();
        x.fillStyle = '#fff'; x.beginPath(); x.ellipse(86, 78, 30, 36, -.4, 0, 7); x.fill(); x.beginPath(); x.arc(170, 178, 14, 0, 7); x.fill(); x.beginPath(); x.arc(150, 60, 8, 0, 7); x.fill();
      });
    }
    var accentHex = '#2DD4DE';
    var badgeTex = canvasTex(256, 160, function (x, w, h) { x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.fillStyle = '#0B0D17'; x.fillRect(0, 0, w, 40); drawL(x, 60, 98, 70, '#0B0D17', '#2DD4DE'); x.fillStyle = '#0B0D17'; x.font = '700 44px Poppins, Arial, sans-serif'; x.fillText('LIA', 112, 108); x.fillStyle = '#2DD4DE'; x.font = '500 18px Poppins, Arial, sans-serif'; x.fillText('LIAME', 112, 136); x.fillRect(0, 34, w, 6); });
    var capTex = canvasTex(256, 256, function (x) { x.fillStyle = '#2B2F45'; x.beginPath(); x.arc(128, 128, 128, 0, 7); x.fill(); drawL(x, 128, 120, 120, '#F4F2EC', '#2DD4DE'); });
    function signTex(ch) { return canvasTex(128, 128, function (x) { x.fillStyle = '#ffffff'; x.beginPath(); x.arc(64, 64, 58, 0, 7); x.fill(); x.lineWidth = 6; x.strokeStyle = '#0B0D17'; x.stroke(); x.fillStyle = '#0B0D17'; x.font = '800 80px Poppins, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 64, 70); }); }

    var m = {
      skin: mat(0xE8A47E, { roughness: .72 }), hair: mat(0x1E63F0, { roughness: .45, envMapIntensity: .25, side: THREE.DoubleSide }), shine: mat(0x7FC4FF, { roughness: .25, emissive: 0x2a4a90, emissiveIntensity: .15 }),
      suit: mat(0x1E2550, { roughness: .6, side: THREE.DoubleSide }), skirt: mat(0x1E2550, { roughness: .6 }), lapel: mat(0x181D40, { roughness: .4 }), white: mat(0xffffff), shirt: mat(0xF7F8FC),
      dark: mat(0x0b0b24, { roughness: .1, envMapIntensity: 1.1 }), brow: mat(0x12357a, { roughness: .7 }), lip: mat(0xD0566E, { roughness: .35 }), mouthIn: mat(0x5a1826, { roughness: .8 }), tongue: mat(0xE0707F), teeth: mat(0xffffff, { roughness: .3 }),
      blush: new THREE.MeshBasicMaterial({ color: 0xFF6F8A, transparent: true, opacity: .35, depthWrite: false }), tights: mat(0x3b3040, { roughness: .45 }), heels: mat(0x14141f, { roughness: .25, envMapIntensity: 1 }),
      set: mat(0x23263A, { roughness: .35, metalness: .3, envMapIntensity: .8 }), cushion: mat(0x2F3350, { roughness: .8 }), cap: new THREE.MeshStandardMaterial({ map: capTex, roughness: .35 }),
      badge: new THREE.MeshStandardMaterial({ map: badgeTex, roughness: .4 }), gold: mat(0xE8C36A, { roughness: .25, metalness: .8, envMapIntensity: 1 }),
      heart: mat(0xFF4F8B, { emissive: 0xFF4F8B, emissiveIntensity: .35, roughness: .3 }), sleeve: mat(0x1E2550, { roughness: .6 }), sleeveTop: mat(0x1E2550, { roughness: .6 }), cuff: mat(0xF7F8FC), laptop: mat(0xC9CCD6, { roughness: .3, metalness: .6, envMapIntensity: 1 })
    };
    function add(p, g, mt, sh) { var o = new THREE.Mesh(g, mt); o.castShadow = sh !== false && !!opts.shadows; p.add(o); return o; }
    function lathe(pts, ps, pl) { if (pts[0][1] > pts[pts.length-1][1]) pts = pts.slice().reverse(); return new THREE.LatheGeometry(pts.map(function (p) { return new THREE.Vector2(p[0], p[1]); }), 64, ps === undefined ? Math.PI : ps, pl || Math.PI * 2); }

    // ---------------- body
    var lia = new THREE.Group(); scene.add(lia);
    var hips = new THREE.Group(); hips.position.y = .06; lia.add(hips);
    var body = new THREE.Group(); hips.add(body);
    var TS = [1.26, 1, 1.2];
    var torso = new THREE.Group(); torso.scale.set(TS[0], TS[1], TS[2]); body.add(torso);
    var lower = new THREE.Group(); lower.scale.set(TS[0], 1, TS[2]); hips.add(lower);
    // grupos de roupa (ligados/desligados pelas variações de visual)
    var G = {};
    function grp(name, parent) { var g = new THREE.Group(); (parent || torso).add(g); G[name] = g; return g; }
    grp('shirt'); grp('blazer'); grp('knot'); grp('badge'); grp('skirt', lower);
    add(G.shirt, lathe([[0.001,.62],[.2,.62],[.34,.56],[.41,.42],[.4,.2],[.33,.02],[.32,-.06],[0.001,-.06]]), m.shirt);
    [-1, 1].forEach(function (s) { var c = add(G.shirt, new THREE.ConeGeometry(.07, .16, 3), m.shirt); c.position.set(s*.08, .63, .2); c.rotation.set(1.9, 0, s*.6); });
    add(G.blazer, lathe([[.24,.66],[.39,.6],[.47,.46],[.47,.24],[.4,.04],[.39,-.1],[.44,-.24]], .42, Math.PI*2-.84), m.suit);
    [-1, 1].forEach(function (s) {
      var lp = new THREE.Shape(); lp.moveTo(0, 0); lp.lineTo(s*.16, .02); lp.lineTo(s*.12, -.12); lp.lineTo(s*.05, -.36); lp.lineTo(0, -.36); lp.closePath();
      var l = add(G.blazer, new THREE.ExtrudeGeometry(lp, { depth: .03, bevelEnabled: true, bevelThickness: .01, bevelSize: .01, bevelSegments: 2 }), m.lapel);
      l.position.set(s*.13, .6, .33); l.rotation.set(-.28, s*.28, 0);
    });
    var btn = add(G.blazer, new THREE.CylinderGeometry(.034, .034, .022, 20), m.gold); btn.rotation.x = Math.PI/2; btn.position.set(.08, .06, .405);
    add(G.knot, new THREE.SphereGeometry(.055, 16, 12), glow).position.set(0, .6, .27);
    [-1, 1].forEach(function (s) { var t = add(G.knot, new THREE.SphereGeometry(.07, 16, 12), glow); t.scale.set(1.3, .55, .5); t.position.set(s*.07, .58, .27); t.rotation.z = s*.4; });
    var tail = add(G.knot, new THREE.ConeGeometry(.05, .18, 12), glow); tail.position.set(.02, .48, .3); tail.rotation.set(.2, 0, .15);
    var badge = add(G.badge, new THREE.PlaneGeometry(.2, .125), m.badge, false); badge.position.set(-.26, .3, .45); badge.rotation.set(-.12, -.45, 0);
    var clipB = add(G.badge, new THREE.BoxGeometry(.05, .03, .01), m.gold, false); clipB.position.set(-.26, .37, .45); clipB.rotation.y = -.45;
    add(G.skirt, lathe([[.34,.0],[.4,-.12],[.42,-.3],[.38,-.56],[.36,-.6],[0.001,-.6]]), m.skirt);
    var legs = [];
    [-1, 1].forEach(function (s) {
      var g = new THREE.Group(); g.position.set(s*.16, -.66, 0); hips.add(g);
      add(g, lathe([[.001,.24],[.11,.22],[.13,.05],[.12,-.2],[.095,-.42],[.078,-.62],[.072,-.7],[.001,-.72]]), m.tights);
      var sh = add(g, new THREE.SphereGeometry(.1, 28, 18), m.heels); sh.scale.set(1, .62, 1.55); sh.position.set(0, -.75, .06);
      var sole = add(g, new THREE.CylinderGeometry(.075, .085, .05, 24), m.heels); sole.scale.set(1, 1, 1.9); sole.position.set(0, -.8, .06);
      var boot = add(g, new THREE.CylinderGeometry(.125, .11, .44, 24), m.heels); boot.position.y = -.52; boot.userData.boot = true; g.userData.boot = boot; legs.push(g);
    });
    function arm(side) {
      var sh = new THREE.Group(); sh.position.set(side*.54, .47, 0); body.add(sh); add(sh, new THREE.SphereGeometry(.155, 28, 18), m.sleeveTop);
      add(sh, new THREE.CapsuleGeometry(.125, .2, 10, 24), m.sleeveTop).position.y = -.2;
      var el = new THREE.Group(); el.position.y = -.4; sh.add(el);
      add(el, new THREE.CapsuleGeometry(.11, .13, 10, 24), m.sleeve).position.y = -.1;
      var cf = add(el, new THREE.TorusGeometry(.105, .03, 10, 28), m.cuff); cf.rotation.x = Math.PI/2; cf.position.y = -.22;
      var wr = new THREE.Group(); wr.position.y = -.31; el.add(wr);
      var hm = add(wr, new THREE.SphereGeometry(.1, 24, 16), m.skin); hm.scale.set(.95, 1.2, .7); hm.position.y = -.07;
      var th = add(wr, new THREE.CapsuleGeometry(.03, .05, 6, 10), m.skin); th.position.set(-side*.075, -.05, .03); th.rotation.z = side*.7;
      return { sh: sh, el: el, wr: wr };
    }
    var armL = arm(1), armR = arm(-1);

    // ---------------- head
    add(body, new THREE.CylinderGeometry(.14, .17, .3, 28), m.skin).position.y = .72;
    var hp = new THREE.Group(); hp.position.y = .84; body.add(hp);
    var head = new THREE.Group(); head.position.y = .64; head.scale.setScalar(.88); hp.add(head);
    add(head, new THREE.SphereGeometry(1, 64, 48), m.skin).scale.set(1, 1.04, .96);
    var jaw = add(head, new THREE.SphereGeometry(.6, 48, 32), m.skin); jaw.scale.set(1.1, .82, 1); jaw.position.set(0, -.36, .26);
    var nose = add(head, new THREE.SphereGeometry(.06, 20, 14), m.skin); nose.scale.set(1, .8, .9); nose.position.set(0, -.15, .955);
    [-1, 1].forEach(function (s) { var b = add(head, new THREE.SphereGeometry(.15, 20, 14), m.blush, false); b.scale.set(1.3, .6, .4); b.position.set(s*.5, -.22, .8); });
    var IRISM = new THREE.MeshBasicMaterial({ map: makeIris(0x2a5fe0) });
    // íris como calota esférica: acompanha a curva do olho e fica sempre sob a pálpebra
    function irisCap(R) {
      var g = new THREE.SphereGeometry(R*1.004, 48, 16, 0, Math.PI*2, 0, .78); g.rotateX(Math.PI/2);
      var p = g.attributes.position, uv = g.attributes.uv, rx = R*Math.sin(.78), ry = rx*1.18;
      for (var i = 0; i < p.count; i++) { var y = p.getY(i)*1.18; p.setY(i, y); if (p.getZ(i) < 0) {} uv.setXY(i, p.getX(i)/(2*rx) + .5, y/(2*ry) + .5); }
      // mantém a calota sobre a esfera após esticar em y
      for (var j = 0; j < p.count; j++) { var v = new THREE.Vector3(p.getX(j), p.getY(j), p.getZ(j)).setLength(R*1.004); p.setXYZ(j, v.x, v.y, v.z); }
      g.computeVertexNormals(); return g;
    }
    var eyes = [];
    (function () {
      var Rr = .24, scl = mat(0xffffff, { roughness: .12, envMapIntensity: .8 });
      [-1, 1].forEach(function (s) {
        var sock = new THREE.Group(); sock.position.set(s*.35, 0, .75); head.add(sock);
        var ball = new THREE.Group(); sock.add(ball); add(ball, new THREE.SphereGeometry(Rr, 40, 32), scl, false);
        var ir = add(ball, irisCap(Rr), IRISM, false);
        var top = new THREE.Group(); sock.add(top); add(top, new THREE.SphereGeometry(Rr*1.07, 40, 20, 0, Math.PI*2, 0, Math.PI/2), m.skin, false);
        var liner = add(top, new THREE.TorusGeometry(Rr*1.075, .026, 8, 40, Math.PI), m.dark, false); liner.rotation.x = Math.PI/2;
        for (var k = 0; k < 3; k++) { var c = add(top, new THREE.ConeGeometry(.022, .13, 8), m.dark, false); var a = s > 0 ? .15 + k*.2 : Math.PI - .15 - k*.2; c.position.set(Math.cos(a)*Rr*1.08, .01, Math.sin(a)*Rr*1.08); c.rotation.set(-.5, 0, -s*(1.1-k*.2)); }
        var bot = new THREE.Group(); sock.add(bot); add(bot, new THREE.SphereGeometry(Rr*1.06, 40, 20, 0, Math.PI*2, Math.PI/2, Math.PI/2), m.skin, false);
        var bg = new THREE.Group(); bg.position.set(s*.35, .33, .87); head.add(bg); add(bg, new THREE.CapsuleGeometry(.021, .17, 6, 12), m.brow).rotation.z = Math.PI/2;
        var wl = add(sock, new THREE.TorusGeometry(Rr*.72, .024, 8, 32, Math.PI*.8), m.dark, false); wl.position.set(0, -.07, Rr*1.1); wl.rotation.z = Math.PI*.1; wl.scale.set(1, .75, 1); wl.visible = false;
        eyes.push({ s: s, ball: ball, top: top, bot: bot, brow: bg, baseY: .33, wl: wl });
      });
    })();
    var mouth = new THREE.Group(); mouth.position.set(0, -.43, .9); mouth.rotation.x = .38; head.add(mouth);
    var smile = add(mouth, new THREE.TorusGeometry(.12, .024, 10, 32, Math.PI), m.lip, false); smile.rotation.z = Math.PI;
    var openM = new THREE.Group(); mouth.add(openM); add(openM, new THREE.SphereGeometry(1, 32, 16, 0, Math.PI*2, Math.PI/2, Math.PI/2), m.mouthIn, false);
    var tg = add(openM, new THREE.SphereGeometry(.55, 20, 12), m.tongue, false); tg.scale.set(1, .45, .5); tg.position.set(0, -.55, .2);
    add(openM, new THREE.BoxGeometry(1.4, .22, .3), m.teeth, false).position.set(0, -.1, .35);
    var ohM = add(mouth, new THREE.SphereGeometry(1, 24, 16), m.mouthIn, false); ohM.position.z = .01;
    var ohLip = add(mouth, new THREE.TorusGeometry(1, .18, 8, 32), m.lip, false);

    // ---------------- anime hair
    add(head, new THREE.SphereGeometry(1.12, 64, 32, 0, Math.PI*2, 0, .82), m.hair).scale.set(1.05, 1.05, 1.03);
    add(head, new THREE.SphereGeometry(1.1, 64, 40, Math.PI/2+.85, Math.PI*2-1.7, 0, 1.95), m.hair).scale.set(1.07, 1.04, 1.04);
    add(head, new THREE.SphereGeometry(1.1, 48, 32, Math.PI*1.5 - 1.25, 2.5, 0, 2.5), m.hair).scale.set(1.06, 1.03, 1.04);
    var shine = add(head, new THREE.TorusGeometry(1.1, .035, 8, 80, Math.PI*1.1), m.shine, false); shine.rotation.set(Math.PI/2-.55, 0, Math.PI*.95); shine.position.y = .45; shine.scale.set(1.02, 1.02, 1);
    var spikes = [];
    function spike(par, x, y, z, len, r, rx, rz) { var g = new THREE.Group(); g.position.set(x, y, z); par.add(g); var c = add(g, new THREE.ConeGeometry(r, len, 18), m.hair); c.position.y = -len/2; c.rotation.x = Math.PI; g.rotation.set(rx, 0, rz); g.userData.b = { x: rx, z: rz }; spikes.push(g); return g; }
    [[-.62,.62,.72,.62,.17,-.12,.35],[-.34,.72,.8,.7,.19,-.15,.12],[-.04,.74,.84,.62,.18,-.18,-.08],[.26,.72,.8,.72,.19,-.15,-.2],[.56,.62,.74,.6,.17,-.12,-.38]].forEach(function (q) { spike(head, q[0], q[1], q[2], q[3], q[4], q[5], q[6]); });
    [-1, 1].forEach(function (s) { spike(head, s*.9, .35, .45, 1.35, .2, -.12, s*.12); spike(head, s*.98, .3, -.22, 1.2, .2, .05, s*.2); });
    for (var i = 0; i < 7; i++) { var a = Math.PI*.2 + i*(Math.PI*.6/6), x = Math.cos(a)*.95, z = -Math.sin(a)*.8; spike(head, x, .1, z, 1.1, .24, .25*(-z), -.3*x); }
    var ahoge = new THREE.Group(); ahoge.position.set(.05, 1.12, .1); head.add(ahoge);
    add(ahoge, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0), new THREE.Vector3(.08,.25,.05), new THREE.Vector3(.28,.35,.12), new THREE.Vector3(.35,.22,.16)]), 24, .035, 8), m.hair);

    // ---------------- headset
    var hs = new THREE.Group(); head.add(hs);
    var arc = add(hs, new THREE.TorusGeometry(1.22, .07, 16, 96, Math.PI), m.set); arc.rotation.set(-.18, 0, 0); arc.position.y = .02;
    var arcPad = add(hs, new THREE.TorusGeometry(1.17, .045, 12, 64, Math.PI*.5), m.cushion); arcPad.rotation.set(-.18, 0, Math.PI*.25); arcPad.position.y = .02;
    var arcLine = add(hs, new THREE.TorusGeometry(1.29, .018, 8, 96, Math.PI), glow, false); arcLine.rotation.set(-.18, 0, 0); arcLine.position.y = .02;
    var cups = [];
    [-1, 1].forEach(function (s) {
      var g = new THREE.Group(); g.position.set(s*1.2, .02, 0); g.position.applyAxisAngle(new THREE.Vector3(1, 0, 0), -.18); g.rotation.z = -s*Math.PI/2; hs.add(g);
      add(g, new THREE.CylinderGeometry(.34, .34, .1, 48), m.cushion).position.y = -.02;
      add(g, new THREE.CylinderGeometry(.32, .36, .2, 48), m.set).position.y = .1;
      var face = add(g, new THREE.CircleGeometry(.27, 48), m.cap, false); face.position.y = .205; face.rotation.x = -Math.PI/2; face.rotation.z = s > 0 ? -Math.PI/2 : Math.PI/2;
      var ring = add(g, new THREE.TorusGeometry(.3, .028, 10, 64), glow, false); ring.rotation.x = Math.PI/2; ring.position.y = .2;
      add(g, new THREE.SphereGeometry(.035, 12, 10), micGlow, false).position.set(0, .14, .31);
      cups.push({ g: g, ring: ring, s: s });
    });
    var mc = [new THREE.Vector3(-1.32,-.05,.12), new THREE.Vector3(-1.2,-.45,.55), new THREE.Vector3(-.75,-.62,.88), new THREE.Vector3(-.3,-.56,1.02)];
    add(hs, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(mc), 40, .028, 10), m.set);
    var mic = add(hs, new THREE.CapsuleGeometry(.06, .1, 8, 16), micGlow); mic.position.set(-.26, -.55, 1.03); mic.rotation.z = Math.PI/2;
    var micRing = add(hs, new THREE.TorusGeometry(.07, .012, 8, 24), m.set, false); micRing.position.set(-.34, -.555, 1.02); micRing.rotation.y = Math.PI/2;
    var waves = [];
    cups.forEach(function (c) { for (var i = 0; i < 3; i++) { var w = new THREE.Mesh(new THREE.TorusGeometry(.38, .018, 8, 64), new THREE.MeshBasicMaterial({ color: 0x2DD4DE, transparent: true, depthWrite: false })); w.rotation.x = Math.PI/2; c.g.add(w); w.position.y = .25; waves.push({ w: w, i: i }); } });
    var voice = [0, 1].map(function () { var v = new THREE.Mesh(new THREE.TorusGeometry(.1, .01, 8, 32), new THREE.MeshBasicMaterial({ color: 0x2DD4DE, transparent: true, depthWrite: false })); v.position.copy(mic.position); v.position.x += .06; v.rotation.y = Math.PI/2; hs.add(v); return v; });

    // ---------------- props & effects
    if (opts.floorRing) { var fring = add(lia, new THREE.TorusGeometry(.85, .035, 12, 72), glow, false); fring.rotation.x = Math.PI/2; fring.position.y = -1.39; }
    var bub = new THREE.Group(); bub.position.set(1.35, 3.05, 0); lia.add(bub); add(bub, bubbleGeo(.08), glow).position.z = -.04;
    var bdots = [-.13, 0, .13].map(function (q) { var d = add(bub, new THREE.SphereGeometry(.042, 16, 12), mat(0x0B0D17), false); d.position.set(q, 0, .1); return d; });
    // analytics hologram
    var hc = document.createElement('canvas'); hc.width = 512; hc.height = 320; var hx = hc.getContext('2d'); var holoTex = new THREE.CanvasTexture(hc);
    var holo = new THREE.Mesh(new THREE.PlaneGeometry(1.4, .88), new THREE.MeshBasicMaterial({ map: holoTex, transparent: true, depthWrite: false, side: THREE.DoubleSide })); holo.position.set(0, .3, 1.2); holo.rotation.x = -.4; lia.add(holo);
    function drawHolo(t) {
      hx.clearRect(0, 0, 512, 320); hx.fillStyle = 'rgba(11,13,23,.6)'; hx.fillRect(0, 0, 512, 320); hx.strokeStyle = accentHex; hx.lineWidth = 4; hx.strokeRect(6, 6, 500, 308);
      hx.fillStyle = accentHex; hx.font = '500 24px "JetBrains Mono", monospace'; hx.fillText('CAMPANHAS · HOJE', 26, 46);
      for (var i = 0; i < 7; i++) { var h = 40 + 110*(.5 + .5*Math.sin(t*2 + i*.9)); hx.fillStyle = i % 2 ? '#7B61FF' : accentHex; hx.fillRect(34 + i*62, 285 - h, 40, h); }
      hx.strokeStyle = '#FFC24B'; hx.lineWidth = 5; hx.beginPath(); for (var j = 0; j <= 40; j++) { var x = 30 + j*11.4, y = 150 - 30*Math.sin(t*1.5 + j*.35) - j*1.6; j ? hx.lineTo(x, y) : hx.moveTo(x, y); } hx.stroke(); holoTex.needsUpdate = true;
    }
    // laptop (working)
    var laptop = new THREE.Group(); laptop.position.set(0, .02, .78); lia.add(laptop);
    add(laptop, new THREE.BoxGeometry(.95, .035, .6), m.laptop);
    var kc = document.createElement('canvas'); kc.width = 256; kc.height = 160; var kx = kc.getContext('2d');
    kx.fillStyle = '#2a2d38'; kx.fillRect(0, 0, 256, 160); kx.fillStyle = '#4a4e5c'; for (var r = 0; r < 4; r++) for (var q = 0; q < 12; q++) kx.fillRect(10 + q*20, 12 + r*22, 16, 16); kx.fillRect(60, 104, 136, 16); kx.fillStyle = '#5a5e6c'; kx.fillRect(88, 126, 80, 28);
    var keys = add(laptop, new THREE.PlaneGeometry(.86, .5), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(kc), roughness: .6 }), false); keys.rotation.x = -Math.PI/2; keys.position.set(0, .019, -.04);
    var lid = new THREE.Group(); lid.position.set(0, .02, .29); laptop.add(lid); lid.rotation.x = .28;
    add(lid, new THREE.BoxGeometry(.95, .52, .03), m.laptop).position.y = .26;
    var sc = document.createElement('canvas'); sc.width = 320; sc.height = 200; var sx = sc.getContext('2d'); var scrTex = new THREE.CanvasTexture(sc);
    var screen = add(lid, new THREE.PlaneGeometry(.86, .46), new THREE.MeshBasicMaterial({ map: scrTex }), false); screen.position.set(0, .26, -.017); screen.rotation.y = Math.PI;
    var logoBack = add(lid, new THREE.CircleGeometry(.12, 32), m.cap, false); logoBack.position.set(0, .28, .017);
    function drawScreen(t) {
      sx.fillStyle = '#0B0D17'; sx.fillRect(0, 0, 320, 200); sx.fillStyle = accentHex; sx.font = '600 13px "JetBrains Mono", monospace'; sx.fillText('liame · painel', 12, 20);
      for (var i = 0; i < 8; i++) { var w = 40 + 200*(.5 + .5*Math.sin(t*1.7 + i)); sx.fillStyle = i % 3 ? '#3a4166' : '#7B61FF'; sx.fillRect(12, 34 + i*16, w, 9); }
      if (Math.floor(t*2) % 2) { sx.fillStyle = '#ffffff'; sx.fillRect(12 + ((t*40) % 240), 170, 8, 14); }
      scrTex.needsUpdate = true;
    }
    // sign sprites ? !
    function sprite(tex, x, y) { var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); s.position.set(x, y, 0); s.scale.set(.55, .55, 1); lia.add(s); return s; }
    var qSign = sprite(signTex('?'), 1.15, 2.95), eSign = sprite(signTex('!'), 1.15, 2.95);
    // hearts
    var hearts = [];
    for (var hI = 0; hI < 6; hI++) { var hm = add(lia, new THREE.ExtrudeGeometry(HS, { depth: .08, bevelEnabled: true, bevelThickness: .03, bevelSize: .03, bevelSegments: 2 }), m.heart, false); hm.scale.setScalar(.35); hm.userData = { a: hI/6*Math.PI*2, o: hI/6 }; hearts.push(hm); }
    // sparkles / confetti
    var spark = [];
    var confCols = [0x2DD4DE, 0xFFC24B, 0xFF4F8B, 0x7B61FF, 0x39D98A];
    for (var sI = 0; sI < 26; sI++) { var sp = new THREE.Mesh(sI % 2 ? new THREE.OctahedronGeometry(.055) : new THREE.BoxGeometry(.07, .07, .015), new THREE.MeshBasicMaterial({ color: confCols[sI % 5], transparent: true })); sp.userData = { a: Math.random()*Math.PI*2, r: 1.1 + Math.random()*.8, s: .4 + Math.random()*.8, o: Math.random() }; lia.add(sp); spark.push(sp); }

    // ---------------- VARIAÇÕES DE VISUAL (estações e datas comemorativas)
    function patTex(kind, a, b, c) {
      return canvasTex(256, 256, function (x) {
        if (kind === 'plaid') { x.fillStyle = a; x.fillRect(0, 0, 256, 256); x.globalAlpha = .55; x.fillStyle = b; for (var i = 0; i < 256; i += 64) { x.fillRect(i, 0, 26, 256); x.fillRect(0, i, 256, 26); } x.globalAlpha = .9; x.fillStyle = c; for (var j = 0; j < 256; j += 64) { x.fillRect(j + 36, 0, 5, 256); x.fillRect(0, j + 36, 256, 5); } x.globalAlpha = 1; }
        else if (kind === 'floral') { x.fillStyle = a; x.fillRect(0, 0, 256, 256); var cols = [b, c, '#FFFFFF', '#FFD34D']; for (var k = 0; k < 26; k++) { var fx = (k*97) % 256, fy = (k*61 + 30) % 256, col = cols[k % 4]; x.fillStyle = col; for (var p = 0; p < 5; p++) { var an = p/5*Math.PI*2; x.beginPath(); x.ellipse(fx + Math.cos(an)*9, fy + Math.sin(an)*9, 7, 5, an, 0, 7); x.fill(); } x.fillStyle = '#FFD34D'; x.beginPath(); x.arc(fx, fy, 4, 0, 7); x.fill(); } }
        else if (kind === 'sequin') { var cs = [a, b, c]; for (var yy = 0; yy < 256; yy += 12) for (var xx = 0; xx < 256; xx += 12) { x.fillStyle = cs[((xx + yy)/12 + (yy % 24 ? 1 : 0)) % 3 | 0]; x.beginPath(); x.arc(xx + 6 + (yy % 24 ? 6 : 0), yy + 6, 5.5, 0, 7); x.fill(); } x.fillStyle = 'rgba(255,255,255,.5)'; for (var q = 0; q < 60; q++) { x.fillRect((q*53) % 256, (q*91) % 256, 3, 3); } }
        else if (kind === 'knit') { x.fillStyle = a; x.fillRect(0, 0, 256, 256); x.strokeStyle = b; x.lineWidth = 5; for (var r = 0; r < 256; r += 16) for (var t = 0; t < 256; t += 16) { x.beginPath(); x.moveTo(t, r); x.lineTo(t + 8, r + 12); x.lineTo(t + 16, r); x.stroke(); } x.fillStyle = c; x.fillRect(0, 100, 256, 20); x.fillRect(0, 180, 256, 20); }
        else if (kind === 'stripes') { x.fillStyle = a; x.fillRect(0, 0, 256, 256); x.fillStyle = b; for (var z = 0; z < 256; z += 42) x.fillRect(0, z, 256, 18); }
      });
    }
    var O = { // materiais das variações
      dress: mat(0xffffff, { roughness: .6 }), coat: mat(0x6B4226, { roughness: .75 }), fur: mat(0xFFFFFF, { roughness: 1, map: canvasTex(128, 128, function (x) { x.fillStyle = '#fff'; x.fillRect(0, 0, 128, 128); for (var i = 0; i < 900; i++) { var g = 200 + Math.random()*55 | 0; x.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')'; x.fillRect(Math.random()*128, Math.random()*128, 2, 4); } }) }), scarf: mat(0xC0392B, { roughness: .9 }),
      hat: mat(0xC0392B, { roughness: .7 }), hat2: mat(0xFFFFFF, { roughness: .9 }), acc: mat(0xFFC24B, { roughness: .25, metalness: .8, envMapIntensity: 1 }), gem: mat(0xFF4FA3, { roughness: .1, emissive: 0xFF4FA3, emissiveIntensity: .3 }),
      prop: mat(0xC0392B, { roughness: .5 }), prop2: mat(0xFFC24B, { roughness: .4 }), belt: mat(0x14141F, { roughness: .4 }), paint: new THREE.MeshBasicMaterial({ color: 0x2EC27E })
    };
    // vestido evasê (cobre o tronco)
    grp('dress', lower); add(G.dress, lathe([[0.001,.72],[.22,.74],[.37,.67],[.44,.52],[.42,.3],[.34,.12],[.36,0],[.48,-.25],[.58,-.46],[.6,-.5],[0.001,-.5]]), O.dress);
    grp('dressBelt', lower); var dBelt = add(G.dressBelt, new THREE.TorusGeometry(.345, .03, 10, 64), O.belt); dBelt.rotation.x = Math.PI/2; dBelt.position.y = .1; var buckle = add(G.dressBelt, new THREE.BoxGeometry(.09, .07, .02), O.acc, false); buckle.position.set(0, .1, .35);
    grp('furHem', lower); var fh = add(G.furHem, new THREE.TorusGeometry(.6, .05, 10, 72), O.fur); fh.rotation.x = Math.PI/2; fh.position.y = -.5;
    // casaco longo com gola de pelo
    grp('coat'); add(G.coat, lathe([[.25,.67],[.41,.61],[.5,.46],[.5,.24],[.44,.04],[.47,-.2],[.54,-.5],[.57,-.66]], .36, Math.PI*2-.72), O.coat); O.coat.side = THREE.DoubleSide;
    var coatCollar = add(G.coat, new THREE.TorusGeometry(.27, .12, 14, 40, Math.PI*1.6), O.fur); coatCollar.rotation.set(Math.PI/2, 0, Math.PI*.75); coatCollar.position.y = .64;
    [.3, .12, -.08].forEach(function (y) { add(G.coat, new THREE.SphereGeometry(.03, 12, 8), O.acc).position.set(.14, y, .5); });
    // capa (halloween)
    grp('cape'); add(G.cape, lathe([[.28,.66],[.46,.55],[.58,.1],[.66,-.4],[.72,-.72]], Math.PI/2 + .25, Math.PI - .5), O.coat);
    // cachecol de tricô
    grp('scarf'); var sc1 = add(G.scarf, new THREE.TorusGeometry(.2, .09, 12, 32), O.scarf); sc1.rotation.x = Math.PI/2; sc1.position.y = .64;
    var sc2 = add(G.scarf, new THREE.BoxGeometry(.16, .5, .06), O.scarf); sc2.position.set(.1, .36, .44); sc2.rotation.set(-.15, 0, .12);
    // camisa da torcida: gola e faixas
    grp('jersey'); var jc = add(G.jersey, new THREE.TorusGeometry(.2, .035, 10, 40), O.paint); jc.rotation.x = Math.PI/2; jc.position.y = .63;
    // chapéus e acessórios de cabeça
    grp('santa', head); (function () {
      var g = new THREE.Group(); g.position.set(0, .86, -.06); g.rotation.set(-.14, 0, 0); G.santa.add(g);
      add(g, new THREE.CylinderGeometry(.62, 1.1, .62, 40, 1, true), O.hat).position.y = .36; add(g, new THREE.CircleGeometry(.62, 32), O.hat).rotation.x = -Math.PI/2;
      g.children[1].position.y = .67;
      var tipG = new THREE.Group(); tipG.position.set(0, .64, 0); tipG.rotation.z = -1.45; g.add(tipG);
      add(tipG, new THREE.SphereGeometry(.62, 24, 12, 0, Math.PI*2, 0, Math.PI/2), O.hat).scale.y = .35;
      var tc = add(tipG, new THREE.ConeGeometry(.5, .95, 32), O.hat); tc.position.y = .47;
      var pom = add(tipG, new THREE.SphereGeometry(.2, 20, 14), O.fur); pom.position.y = .98;
      var band = add(g, new THREE.TorusGeometry(1.07, .12, 16, 64), O.fur); band.rotation.x = Math.PI/2; band.position.y = .04;
      G.santa.userData.tip = tipG;
    })();
    grp('witch', head); (function () { var g = new THREE.Group(); g.position.set(0, 1.1, -.05); g.rotation.set(-.15, 0, -.12); G.witch.add(g); add(g, new THREE.CylinderGeometry(1.35, 1.35, .05, 48), O.hat); var c1 = add(g, new THREE.ConeGeometry(.6, .8, 32), O.hat); c1.position.y = .4; var c2 = add(g, new THREE.ConeGeometry(.28, .6, 24), O.hat); c2.position.set(.18, .95, 0); c2.rotation.z = -.6; var band = add(g, new THREE.CylinderGeometry(.61, .61, .12, 32, 1, true), O.prop2); band.position.y = .08; })();
    grp('straw', head); (function () { var g = new THREE.Group(); g.position.set(0, 1.08, -.05); g.rotation.set(-.12, 0, .08); G.straw.add(g); add(g, new THREE.CylinderGeometry(1.3, 1.35, .05, 48), O.hat); var cr = add(g, new THREE.CylinderGeometry(.62, .7, .38, 32), O.hat); cr.position.y = .2; var rb = add(g, new THREE.CylinderGeometry(.705, .705, .1, 32, 1, true), O.hat2); rb.position.y = .06; ['#FF3B3B','#FFC24B','#2DD4DE','#39D98A'].forEach(function (c, i) { var r = add(g, new THREE.BoxGeometry(.06, .5, .01), mat(c), false); r.position.set(-.6 + i*.05, -.2, .5); r.rotation.z = .2 - i*.08; }); })();
    grp('flowers', head); (function () { var cols = [0xFF8FB3, 0xFFD34D, 0xFFFFFF, 0xB9A8FF, 0xFF6F8A]; for (var i = 0; i < 11; i++) { var a = Math.PI*.1 + i/10*Math.PI*.8; var f = add(G.flowers, new THREE.SphereGeometry(.11, 14, 10), mat(cols[i % 5]), false); f.scale.set(1, .6, 1); f.position.set(Math.cos(a)*1.12, .62 + Math.sin(a)*.42, Math.sin(a)*.3 - .05); var l = add(G.flowers, new THREE.SphereGeometry(.06, 10, 8), mat(0x39B26A), false); l.position.copy(f.position).add(new THREE.Vector3(.07, -.05, .05)); } })();
    grp('bunny', head); (function () {
      var furW = O.fur, pink = mat(0xFFB3CC, { roughness: .8 });
      var hb = add(G.bunny, new THREE.TorusGeometry(1.16, .045, 10, 64, Math.PI), pink); hb.rotation.set(-.5, 0, 0); hb.position.y = .02;
      var ears = [];
      [-1, 1].forEach(function (s) {
        var g = new THREE.Group(); g.position.set(s*.42, 1.02, .45); g.rotation.set(-.2, 0, -s*.22); G.bunny.add(g);
        add(g, new THREE.SphereGeometry(.15, 16, 12), furW).scale.set(1, .7, .8);
        var lo = add(g, new THREE.CapsuleGeometry(.14, .34, 8, 20), furW); lo.position.y = .27; lo.scale.z = .42;
        var li = add(g, new THREE.CapsuleGeometry(.085, .3, 6, 14), pink, false); li.position.set(0, .28, .045); li.scale.z = .25;
        var tip = new THREE.Group(); tip.position.y = .5; g.add(tip);
        var up = add(tip, new THREE.CapsuleGeometry(.15, .3, 8, 20), furW); up.position.y = .2; up.scale.z = .42;
        var ui = add(tip, new THREE.CapsuleGeometry(.09, .26, 6, 14), pink, false); ui.position.set(0, .2, .045); ui.scale.z = .25;
        ears.push({ g: g, tip: tip, s: s, bz: -s*.22 });
      });
      G.bunny.userData.ears = ears;
    })();
    grp('tiara', head); (function () { var t = add(G.tiara, new THREE.TorusGeometry(.95, .035, 8, 48, Math.PI), O.acc); t.rotation.set(-.55, 0, 0); t.position.y = .62; for (var i = 0; i < 5; i++) { var a = Math.PI*.2 + i*Math.PI*.15; var g = add(G.tiara, new THREE.OctahedronGeometry(.07 + (i === 2 ? .05 : 0)), O.gem, false); g.position.set(Math.cos(a)*.95, .62 + Math.sin(a)*.95*Math.cos(.55) + .06, -Math.sin(a)*.95*Math.sin(.55)*-1 - .1); } })();
    grp('feathers', head); (function () { var cols = [0xFF4FA3, 0xFFC24B, 0x2DD4DE, 0x7B61FF, 0x39D98A, 0xFF6B3D, 0x2DD4DE, 0xFFC24B, 0xFF4FA3]; for (var i = 0; i < 9; i++) { var a = -1.1 + i*.275; var g = new THREE.Group(); g.position.set(0, .9, -.35); g.rotation.set(-.35, 0, a); G.feathers.add(g); var f = add(g, new THREE.SphereGeometry(.2, 16, 10), mat(cols[i], { emissive: cols[i], emissiveIntensity: .15 })); f.scale.set(.45, 2.4, .12); f.position.y = .75; } var gem = add(G.feathers, new THREE.OctahedronGeometry(.13), O.acc, false); gem.position.set(0, .95, .75); })();
    grp('beret', head); (function () { var b = add(G.beret, new THREE.SphereGeometry(.95, 32, 16), O.hat); b.scale.set(1.05, .28, 1.05); b.position.set(.15, 1.08, -.05); b.rotation.z = -.22; add(G.beret, new THREE.CylinderGeometry(.04, .04, .1, 8), O.hat).position.set(.2, 1.36, -.05); })();
    grp('sunglasses', head); (function () { var g = new THREE.Group(); g.position.set(0, .92, .55); g.rotation.x = -.7; G.sunglasses.add(g); [-1, 1].forEach(function (s) { var l = add(g, new THREE.CylinderGeometry(.17, .17, .03, 24), mat(0x1a1a24, { roughness: .1, envMapIntensity: 1.2 }), false); l.rotation.x = Math.PI/2; l.position.x = s*.22; l.scale.z = .8; }); add(g, new THREE.BoxGeometry(.14, .03, .03), O.acc, false); })();
    grp('heartClip', head); (function () { var h = add(G.heartClip, new THREE.ExtrudeGeometry(HS, { depth: .06, bevelEnabled: true, bevelThickness: .02, bevelSize: .02, bevelSegments: 2 }), O.gem, false); h.scale.setScalar(.45); h.position.set(.68, .66, .72); h.rotation.set(-.3, .5, -.3); })();
    // detalhes no rosto
    grp('freckles', head); [-1, 1].forEach(function (s) { for (var i = 0; i < 5; i++) { var d = add(G.freckles, new THREE.SphereGeometry(.018, 8, 6), mat(0x8a4a2a), false); d.position.set(s*(.42 + (i % 3)*.06), -.16 - (i > 2 ? .05 : 0), .86 - (i % 3)*.03); } });
    grp('glitter', head); [-1, 1].forEach(function (s) { for (var i = 0; i < 7; i++) { var d = add(G.glitter, new THREE.OctahedronGeometry(.022), mat([0xFFC24B, 0xFF4FA3, 0x2DD4DE][i % 3], { emissive: [0xFFC24B, 0xFF4FA3, 0x2DD4DE][i % 3], emissiveIntensity: .5 }), false); d.position.set(s*(.5 + Math.cos(i)*.08), .12 + Math.sin(i*1.7)*.07, .8); } });
    grp('facepaint', head); (function () { var a = add(G.facepaint, new THREE.BoxGeometry(.16, .035, .01), O.paint, false); a.position.set(.5, -.2, .82); a.rotation.y = .5; var b = add(G.facepaint, new THREE.BoxGeometry(.16, .035, .01), new THREE.MeshBasicMaterial({ color: 0xFFD400 }), false); b.position.set(.5, -.25, .81); b.rotation.y = .5; })();
    // objetos na mão (mão direita)
    grp('gift', armR.wr); (function () { var g = add(G.gift, new THREE.BoxGeometry(.26, .22, .22), O.prop); g.position.set(0, -.25, .08); var r1 = add(G.gift, new THREE.BoxGeometry(.27, .05, .23), O.prop2, false); r1.position.set(0, -.25, .08); var r2 = add(G.gift, new THREE.BoxGeometry(.05, .23, .23), O.prop2, false); r2.position.set(0, -.25, .08); })();
    grp('pumpkin', armR.wr); (function () { var p = add(G.pumpkin, new THREE.SphereGeometry(.17, 20, 14), mat(0xFF7A1A, { roughness: .5 })); p.scale.set(1.15, .85, 1.1); p.position.set(0, -.27, .08); add(G.pumpkin, new THREE.CylinderGeometry(.03, .04, .08, 8), mat(0x3a7a2a)).position.set(0, -.12, .08); var eye = new THREE.MeshBasicMaterial({ color: 0x2a1000 }); [-1, 1].forEach(function (s) { var e = add(G.pumpkin, new THREE.ConeGeometry(.035, .05, 3), eye, false); e.position.set(s*.06, -.24, .25); e.rotation.x = Math.PI/2; }); })();
    grp('bag', armR.wr); (function () { var b = add(G.bag, new THREE.BoxGeometry(.3, .32, .12), mat(0x111111, { roughness: .4 })); b.position.set(0, -.36, .05); var h = add(G.bag, new THREE.TorusGeometry(.08, .012, 6, 20, Math.PI), O.prop2, false); h.position.set(0, -.2, .05); var tag = add(G.bag, new THREE.PlaneGeometry(.2, .14), new THREE.MeshBasicMaterial({ map: canvasTex(128, 96, function (x) { x.fillStyle = '#FF2E88'; x.fillRect(0, 0, 128, 96); x.fillStyle = '#fff'; x.font = '800 54px Poppins, Arial'; x.textAlign = 'center'; x.fillText('%', 64, 70); }) }), false); tag.position.set(0, -.36, .115); })();
    grp('bouquet', armR.wr); (function () { var st = add(G.bouquet, new THREE.ConeGeometry(.1, .3, 16), mat(0xF7F8FC)); st.position.set(0, -.25, .08); st.rotation.x = Math.PI; [0xE8284F, 0xFF4F8B, 0xE8284F, 0xFF8FB3, 0xE8284F].forEach(function (c, i) { var r = add(G.bouquet, new THREE.SphereGeometry(.065, 12, 10), mat(c), false); r.position.set(Math.cos(i*1.26)*.07, -.07 + (i % 2)*.03, .08 + Math.sin(i*1.26)*.07); }); })();
    grp('cup', armR.wr); (function () { var c = add(G.cup, new THREE.CylinderGeometry(.09, .075, .18, 20), mat(0xF7F8FC)); c.position.set(0, -.24, .1); var h = add(G.cup, new THREE.TorusGeometry(.05, .014, 6, 16), mat(0xF7F8FC), false); h.position.set(.1, -.24, .1); h.rotation.y = Math.PI/2; var top = add(G.cup, new THREE.CircleGeometry(.08, 20), mat(0x6B3A26), false); top.rotation.x = -Math.PI/2; top.position.set(0, -.155, .1);
      var sl = add(G.cup, new THREE.CylinderGeometry(.087, .08, .08, 20), mat(0xB07A4A, { roughness: .9 }), false); sl.position.set(0, -.25, .1);
      var stTex = canvasTex(64, 64, function (x) { var gr = x.createRadialGradient(32, 32, 2, 32, 32, 30); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); });
      G.cup.userData.steam = [0, 1, 2, 3, 4, 5].map(function (i) { var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: stTex, transparent: true, depthWrite: false, opacity: 0 })); sp.userData.o = i/6; G.cup.add(sp); return sp; });
    })();
    // gola, punhos e barra de pele (casaco de inverno)
    var coatHem = add(G.coat, new THREE.TorusGeometry(.565, .06, 10, 64, Math.PI*2 - .72), O.fur); coatHem.rotation.set(Math.PI/2, 0, -Math.PI/2 + .36); coatHem.position.y = -.66;
    [armL, armR].forEach(function (a, i) { var gname = i ? 'furCuffR' : 'furCuffL'; grp(gname, a.el); var fc = add(G[gname], new THREE.TorusGeometry(.115, .055, 10, 28), O.fur); fc.rotation.x = Math.PI/2; fc.position.y = -.2; });
    // pinheiro de Natal enfeitado (fundo)
    grp('tree', lia); (function () {
      var g = new THREE.Group(); g.position.set(-1.75, -1.41, -1.5); G.tree.add(g);
      var green = mat(0x1F7A4C, { roughness: .8 }), green2 = mat(0x2E9460, { roughness: .8 });
      add(g, new THREE.CylinderGeometry(.12, .15, .35, 12), mat(0x6B4226)).position.y = .17;
      [[1.05, .95, .75], [.85, .85, 1.35], [.62, .75, 1.9], [.38, .6, 2.35]].forEach(function (q, i) { add(g, new THREE.ConeGeometry(q[0], q[1], 28), i % 2 ? green2 : green).position.y = q[2]; });
      var cols = [0xD7263D, 0xFFC24B, 0x2DD4DE, 0xFF4FA3, 0xFFFFFF, 0x7B61FF], orn = [];
      for (var i = 0; i < 22; i++) { var hgt = .45 + Math.random()*1.9, rad = (1 - (hgt - .3)/2.3)*.95 + .03, a = i*2.4; var c = cols[i % cols.length]; var b = add(g, new THREE.SphereGeometry(.055 + (i % 3)*.012, 12, 10), mat(c, { roughness: .2, metalness: .3, emissive: c, emissiveIntensity: .15 }), false); b.position.set(Math.cos(a)*rad, hgt, Math.sin(a)*rad); orn.push(b); }
      var star = new THREE.Shape(); for (var k = 0; k < 10; k++) { var r = k % 2 ? .08 : .2, an = Math.PI/2 + k*Math.PI/5; k ? star.lineTo(Math.cos(an)*r, Math.sin(an)*r) : star.moveTo(Math.cos(an)*r, Math.sin(an)*r); }
      var st = add(g, new THREE.ExtrudeGeometry(star, { depth: .05, bevelEnabled: true, bevelThickness: .015, bevelSize: .015, bevelSegments: 1 }), mat(0xFFD34D, { emissive: 0xFFC24B, emissiveIntensity: .6, roughness: .3 }), false); st.position.set(0, 2.72, 0);
      var gifts = [[.55, .3, 0xD7263D, 0xFFC24B], [-.5, .25, 0x2DD4DE, 0xFFFFFF], [.1, .22, 0x7B61FF, 0xFFC24B]];
      gifts.forEach(function (q, i) { var bx = add(g, new THREE.BoxGeometry(q[1], q[1], q[1]), mat(q[2], { roughness: .5 })); bx.position.set(q[0], q[1]/2, .75 - i*.1); bx.rotation.y = i*.5; var rb = add(bx, new THREE.BoxGeometry(q[1]*1.02, q[1]*1.02, q[1]*.18), mat(q[3], { roughness: .4 }), false); });
      G.tree.userData = { orn: orn, star: st };
    })();
    grp('flag', armR.wr); (function () { var pole = add(G.flag, new THREE.CylinderGeometry(.012, .012, .8, 8), mat(0xdddddd)); pole.position.set(0, .15, .08); var f = add(G.flag, new THREE.PlaneGeometry(.5, .34), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: canvasTex(150, 100, function (x) { x.fillStyle = '#1FA64A'; x.fillRect(0, 0, 150, 100); x.fillStyle = '#FFD400'; x.beginPath(); x.moveTo(75, 10); x.lineTo(140, 50); x.lineTo(75, 90); x.lineTo(10, 50); x.fill(); x.fillStyle = '#1D3F95'; x.beginPath(); x.arc(75, 50, 22, 0, 7); x.fill(); }) }), false); f.position.set(.26, .42, .08); G.flag.userData.cloth = f; })();

    // partículas ambientes
    function partTex(type, v) {
      return canvasTex(64, 64, function (x) {
        x.translate(32, 32);
        if (type === 'snow') { x.fillStyle = 'rgba(255,255,255,.95)'; x.beginPath(); x.arc(0, 0, 10 + v*3, 0, 7); x.fill(); x.shadowColor = '#fff'; }
        else if (type === 'leaf') { x.rotate(v); x.fillStyle = ['#D9722B', '#B5471F', '#E8A93A', '#8A4A1F'][v % 4]; x.beginPath(); x.ellipse(0, 0, 24, 12, 0, 0, 7); x.fill(); x.strokeStyle = 'rgba(0,0,0,.25)'; x.lineWidth = 2; x.beginPath(); x.moveTo(-22, 0); x.lineTo(22, 0); x.stroke(); }
        else if (type === 'flower') { x.rotate(v); var fc = ['#FF8FB3', '#FFFFFF', '#FFD34D', '#B9A8FF', '#FF6F9F', '#FFC6D9'][v % 6]; x.fillStyle = fc; for (var pI2 = 0; pI2 < 5; pI2++) { x.save(); x.rotate(pI2*Math.PI*2/5); x.beginPath(); x.ellipse(0, -13, 8, 12, 0, 0, 7); x.fill(); x.restore(); } x.fillStyle = v % 6 === 2 ? '#FF8A3D' : '#FFD34D'; x.beginPath(); x.arc(0, 0, 7, 0, 7); x.fill(); }
        else if (type === 'petal') { x.rotate(v); x.fillStyle = ['#FF8FB3', '#FFC6D9', '#FFFFFF', '#FFD34D'][v % 4]; x.beginPath(); x.ellipse(0, 0, 16, 10, 0, 0, 7); x.fill(); }
        else if (type === 'star') { x.fillStyle = ['#FFD34D', '#FFFFFF', '#FFC24B', '#E8C36A'][v % 4]; x.beginPath(); for (var i = 0; i < 10; i++) { var r = i % 2 ? 9 : 24, a = -Math.PI/2 + i*Math.PI/5; x.lineTo(Math.cos(a)*r, Math.sin(a)*r); } x.fill(); }
        else if (type === 'flag') { x.fillStyle = ['#FF3B3B', '#FFC24B', '#2DD4DE', '#39D98A', '#7B61FF', '#FF4FA3'][v % 6]; x.beginPath(); x.moveTo(-22, -18); x.lineTo(22, -18); x.lineTo(0, 24); x.fill(); }
        else if (type === 'bat') { x.fillStyle = '#1b0f2a'; x.beginPath(); x.moveTo(0, -4); x.quadraticCurveTo(14, -18, 30, -8); x.quadraticCurveTo(20, -2, 22, 8); x.quadraticCurveTo(12, 2, 0, 10); x.quadraticCurveTo(-12, 2, -22, 8); x.quadraticCurveTo(-20, -2, -30, -8); x.quadraticCurveTo(-14, -18, 0, -4); x.fill(); }
        else if (type === 'heart') { x.fillStyle = ['#FF3B6B', '#FF8FB3', '#E8284F'][v % 3]; x.beginPath(); x.moveTo(0, 20); x.bezierCurveTo(-30, 0, -20, -24, 0, -8); x.bezierCurveTo(20, -24, 30, 0, 0, 20); x.fill(); }
        else if (type === 'confetti') { x.rotate(v); x.fillStyle = ['#FF4FA3', '#FFC24B', '#2DD4DE', '#7B61FF', '#39D98A', '#FF6B3D'][v % 6]; if (v % 3) x.fillRect(-12, -5, 24, 10); else { x.lineWidth = 5; x.strokeStyle = x.fillStyle; x.beginPath(); x.moveTo(-20, 0); x.bezierCurveTo(-10, -16, 10, 16, 20, 0); x.stroke(); } }
        else if (type === 'egg') { x.fillStyle = ['#FFC6D9', '#C9F2E1', '#FFF1A8', '#D9CCFF'][v % 4]; x.beginPath(); x.ellipse(0, 2, 16, 21, 0, 0, 7); x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 4; x.beginPath(); x.moveTo(-15, 0); x.lineTo(-5, -6); x.lineTo(5, 0); x.lineTo(15, -6); x.stroke(); }
        else if (type === 'tag') { x.fillStyle = ['#FF2E88', '#FFD400', '#FFFFFF'][v % 3]; x.beginPath(); x.arc(0, 0, 22, 0, 7); x.fill(); x.fillStyle = '#111'; x.font = '800 26px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('%', 0, 1); }
        else if (type === 'brasil') { x.rotate(v); x.fillStyle = ['#1FA64A', '#FFD400', '#1D3F95', '#FFFFFF'][v % 4]; x.fillRect(-12, -5, 24, 10); }
        else if (type === 'sun') { x.fillStyle = 'rgba(255,214,90,.9)'; x.beginPath(); x.arc(0, 0, 6 + v, 0, 7); x.fill(); }
      });
    }
    var PT = {}, partType = null, parts = new THREE.Group(); scene.add(parts);
    for (var pI = 0; pI < 42; pI++) { var spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })); var sgn = pI % 2 ? 1 : -1; spr.userData = { x: sgn*(.95 + Math.random()*2.1), z: -1.5 + Math.random()*2.6, s: .3 + Math.random()*.7, o: Math.random(), w: Math.random()*6, v: pI }; parts.add(spr); }
    function setParticles(type) {
      partType = type; parts.visible = !!type; if (!type) return;
      if (!PT[type]) { PT[type] = []; for (var i = 0; i < 6; i++) PT[type].push(partTex(type, i)); }
      var N = { bat: 8, snow: 30, confetti: 26, sun: 12, brasil: 16, flower: 24 }[type] || 20;
      parts.children.forEach(function (sp, i) { sp.visible = i < N; sp.material.map = PT[type][i % 6]; sp.material.needsUpdate = true; });
    }
    var PROPS = { gift: 0, pumpkin: 0, bag: 0, cup: .2, bouquet: .26, flag: 0 }, _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();
    // objetos na mão ficam sempre em pé, em qualquer pose do braço
    function uprightProps() {
      if (!propOn) return; armR.wr.updateWorldMatrix(true, false); armR.wr.getWorldQuaternion(_q).invert(); lia.getWorldQuaternion(_q2); _q.multiply(_q2);
      for (var p in PROPS) { var g = G[p]; if (!g.visible) continue; g.quaternion.copy(_q); g.scale.setScalar(1.35); g.position.copy(_v.set(0, PROPS[p], .04).applyQuaternion(_q)); }
    }
    function animParticles(t) {
      if (!partType) return;
      var rise = partType === 'heart' || partType === 'star' || partType === 'egg' || partType === 'tag';
      var fly = partType === 'bat';
      parts.children.forEach(function (sp) {
        var u = sp.userData, sp2 = partType === 'snow' ? .12 : partType === 'bat' ? .25 : .18, ph = (t*sp2*u.s + u.o) % 1;
        var y = rise ? -1.3 + ph*5 : 3.8 - ph*5.2;
        var sway = Math.sin(t*(fly ? 3 : 1.3)*u.s + u.w)*(fly ? .6 : partType === 'leaf' || partType === 'petal' || partType === 'flower' ? .45 : .15);
        sp.position.set(u.x + sway, y, u.z); var size = (partType === 'snow' ? .09 : partType === 'bat' ? .32 : partType === 'flag' ? .22 : .2)*(.7 + u.s*.6);
        sp.scale.set(size, size, 1); sp.material.rotation = partType === 'bat' ? Math.sin(t*9 + u.w)*.25 : t*u.s*1.5 + u.w; sp.material.opacity = Math.min(1, Math.sin(ph*Math.PI)*2);
      });
    }

    // catálogo de visuais
    var ALL_GROUPS = ['tree','furCuffL','furCuffR','shirt','blazer','knot','badge','skirt','dress','dressBelt','furHem','coat','cape','scarf','jersey','santa','witch','straw','flowers','bunny','tiara','feathers','beret','sunglasses','heartClip','freckles','glitter','facepaint','gift','pumpkin','bag','bouquet','cup','flag'];
    var OUTFITS = {
      executiva: { label: 'Executiva', group: 'base', show: ['shirt','blazer','knot','badge','skirt'], sleeve: 'suit' },
      verao: { label: 'Verão', group: 'estacao', period: 'dez a mar', show: ['dress','sunglasses','badge'], sleeve: 'skin', sleeveTop: 'dress', dress: { color: '#FF7A59', tex: ['floral', '#FF7A59', '#FFD34D', '#FFFFFF'] }, tights: 'skin', shoes: '#C98B5A', accent: '#FFC24B', particles: 'sun' },
      outono: { label: 'Outono', group: 'estacao', period: 'mar a jun', show: ['shirt','blazer','badge','skirt','scarf','beret'], sleeve: 'suit', colors: { suit: '#A0522D', skirt: '#5A3A22', shirt: '#FFE9D6' }, scarf: { color: '#E0A33A', tex: ['knit', '#E0A33A', '#C27A1E', '#8B1E3F'] }, hat: '#7A1E36', tights: '#4a2e22', shoes: '#5A3A22', accent: '#E8A93A', particles: 'leaf' },
      inverno: { label: 'Inverno', group: 'estacao', period: 'jun a set', show: ['coat','skirt','badge','cup','furCuffL','furCuffR'], sleeve: 'coat', coat: '#7A4E36', fur: '#F3E7D3', colors: { skirt: '#3A2A22' }, tights: '#2a2433', shoes: '#3a2a22', boots: true, accent: '#2DD4DE', particles: null },
      primavera: { label: 'Primavera', group: 'estacao', period: 'set a dez', show: ['dress','flowers','badge'], sleeve: 'skin', sleeveTop: 'dress', dress: { color: '#FFB3CF', tex: ['floral', '#FFC2D8', '#FF6F9F', '#9D86FF'] }, tights: 'skin', shoes: '#F4F2EC', accent: '#FF8FB3', particles: 'flower' },
      natal: { label: 'Natal', group: 'data', period: '1 a 26 dez', show: ['dress','dressBelt','furHem','santa','gift','tree'], sleeve: 'dress', sleeveTop: 'dress', cuff: '#FFFFFF', dress: { color: '#D7263D' }, hat: '#D7263D', prop: '#2E8B57', prop2: '#FFC24B', tights: '#F4F2EC', shoes: '#14141F', accent: '#FFC24B', particles: 'snow' },
      anonovo: { label: 'Ano Novo', group: 'data', period: '27 dez a 2 jan', show: ['dress','tiara'], sleeve: 'skin', sleeveTop: 'dress', dress: { color: '#FFFFFF', tex: ['sequin', '#FFFFFF', '#E9E4D8', '#F4E3B0'] }, tights: 'skin', shoes: '#E8C36A', accent: '#FFC24B', gem: '#FFFFFF', particles: 'star' },
      carnaval: { label: 'Carnaval', group: 'data', period: 'semana do Carnaval', show: ['dress','feathers','glitter'], sleeve: 'skin', sleeveTop: 'dress', dress: { color: '#FF4FA3', tex: ['sequin', '#FF4FA3', '#FFC24B', '#2DD4DE'] }, tights: 'skin', shoes: '#FFC24B', accent: '#FF4FA3', particles: 'confetti' },
      pascoa: { label: 'Páscoa', group: 'data', period: 'semana da Páscoa', show: ['dress','bunny','badge'], sleeve: 'dress', sleeveTop: 'dress', cuff: '#FFFFFF', dress: { color: '#C9F2E1', tex: ['stripes', '#C9F2E1', '#FFF1A8'] }, gem: '#FFB3CC', tights: '#F4F2EC', shoes: '#FFB3CC', accent: '#FF8FB3', particles: 'egg' },
      namorados: { label: 'Dia dos Namorados', group: 'data', period: '5 a 12 jun', show: ['dress','heartClip','bouquet'], sleeve: 'dress', sleeveTop: 'dress', cuff: '#FFFFFF', dress: { color: '#E8284F' }, gem: '#FF4F8B', tights: '#2a1a22', shoes: '#E8284F', accent: '#FF4F8B', particles: 'heart' },
      junina: { label: 'Festa Junina', group: 'data', period: 'jun a 20 jul', show: ['dress','straw','freckles'], sleeve: 'dress', sleeveTop: 'dress', cuff: '#FFFFFF', dress: { color: '#D7263D', tex: ['plaid', '#F4F2EC', '#D7263D', '#1E63F0'] }, hat: '#E8C77A', tights: '#F4F2EC', shoes: '#6B4226', accent: '#FFC24B', particles: 'flag' },
      halloween: { label: 'Halloween', group: 'data', period: '24 a 31 out', show: ['dress','dressBelt','cape','witch','pumpkin'], sleeve: 'dress', sleeveTop: 'dress', cuff: '#FF7A1A', dress: { color: '#4B2A7B' }, coat: '#14141F', hat: '#1b1030', prop2: '#FF7A1A', tights: '#14141F', shoes: '#14141F', boots: true, accent: '#FF7A1A', particles: 'bat' },
      blackfriday: { label: 'Black Friday', group: 'data', period: 'semana da Black Friday', show: ['shirt','blazer','knot','badge','skirt','bag'], sleeve: 'suit', colors: { suit: '#111111', skirt: '#111111', shirt: '#1B1B1B' }, prop2: '#FFD400', tights: '#14141F', shoes: '#14141F', accent: '#FF2E88', particles: 'tag' },
      torcida: { label: 'Torcida Brasil', group: 'data', period: 'jogos da Seleção', show: ['shirt','jersey','skirt','facepaint','flag'], sleeve: 'shirt', colors: { shirt: '#FFD400', skirt: '#1D3F95' }, cuff: '#1FA64A', tights: 'skin', shoes: '#F4F2EC', accent: '#1FA64A', particles: 'brasil' }
    };
    var outfit = 'executiva', savedColors = null, propOn = false, holdK = 0;
    function texMat(material, spec) {
      if (!spec) return;
      if (typeof spec === 'string') { material.map = null; material.color.set(spec); }
      else { material.color.set(spec.tex ? '#ffffff' : spec.color); material.map = spec.tex ? patTex(spec.tex[0], spec.tex[1], spec.tex[2], spec.tex[3]) : null; if (material.map) { material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping; material.map.repeat.set(3, 2); } }
      material.needsUpdate = true;
    }
    function syncSleeves() {
      var o = OUTFITS[outfit], src = function (k) { return k === 'skin' ? m.skin : k === 'dress' ? O.dress : k === 'coat' ? O.coat : k === 'shirt' ? m.shirt : m.suit; };
      [[m.sleeve, o.sleeve], [m.sleeveTop, o.sleeveTop || o.sleeve]].forEach(function (p) { var s = src(p[1]); p[0].color.copy(s.color); p[0].map = s.map; p[0].needsUpdate = true; });
      m.cuff.color.set(o.cuff || (o.sleeve === 'skin' ? '#' + m.skin.color.getHexString() : '#' + m.shirt.color.getHexString()));
      if (o.tights === 'skin') m.tights.color.copy(m.skin.color);
    }
    function setOutfit(id) {
      if (!OUTFITS[id]) { console.warn('LiaAgent: visual desconhecido', id); return; }
      if (outfit === 'executiva' && id !== 'executiva') savedColors = Object.assign({}, colors);
      outfit = id; var o = OUTFITS[id];
      ALL_GROUPS.forEach(function (g) { if (G[g]) G[g].visible = o.show.indexOf(g) >= 0; });
      if (savedColors) setColors(savedColors);
      if (o.colors) setColors(o.colors);
      if (o.dress) texMat(O.dress, o.dress);
      if (o.coat) texMat(O.coat, o.coat);
      if (o.scarf) texMat(O.scarf, o.scarf);
      O.fur.color.set(o.fur || '#FFFFFF');
      if (o.hat) texMat(O.hat, o.hat);
      if (o.prop) O.prop.color.set(o.prop); if (o.prop2) O.prop2.color.set(o.prop2); if (o.gem) { O.gem.color.set(o.gem); O.gem.emissive.set(o.gem); }
      m.tights.color.set(o.tights && o.tights !== 'skin' ? o.tights : '#3b3040');
      if (o.shoes) m.heels.color.set(o.shoes);
      if (o.accent) SETTERS.accent(o.accent);
      legs.forEach(function (l) { l.userData.boot.visible = !!o.boots; });
      propOn = ['gift','pumpkin','bag','bouquet','cup','flag'].some(function (g) { return o.show.indexOf(g) >= 0; });
      syncSleeves(); setParticles(o.particles || null);
      emit('outfit', id);
    }

    // ---------------- acting data
    function P(o) { return Object.assign({ lS:[.05,.2], lE:[-.2,0], rS:[.05,-.2], rE:[-.2,0], tilt:0, nod:0, twist:0, lidT:1, lidB:0, browUp:0, browAng:0, browL:0, smile:.6, open:0, oh:0, mouthTilt:0, wink:0, blush:0, lookX:0, lookY:0, bub:0, holo:0, waves:0, spark:0, lean:0, set:.4, laptop:0, qmark:0, excl:0, hearts:0, jump:0 }, o); }
    var STATES = {
      idle: P({}),
      wave: P({ lS:[-.1,2.6], lE:[-.2,.3], smile:1, open:.6, lidB:.3, browUp:.6, tilt:.14, lean:-.05, set:.7 }),
      talk: P({ lS:[-.5,.25], lE:[-1.1,0], rS:[-.3,-.3], rE:[-.9,0], smile:.8, browUp:.35, bub:1, set:1 }),
      listen: P({ lS:[-.25,2.35], lE:[-.2,1.95], tilt:.26, browUp:.7, browAng:-.12, smile:.45, lidT:1.12, waves:1, lean:.05, set:1 }),
      think: P({ rS:[-1.25,.4], rE:[-1.85,0], lS:[-.35,.35], lE:[-1.3,0], lookX:-.45, lookY:-.55, smile:.25, browL:.8, browAng:.12, tilt:-.14, nod:-.12, bub:1, lidT:.92, set:.5 }),
      working: P({ lS:[-.95,.1], lE:[-.75,.1], rS:[-.95,-.1], rE:[-.75,-.1], nod:.28, lookY:.7, smile:.4, browAng:.08, lidT:.88, laptop:1, set:.8 }),
      analyze: P({ lS:[-.95,.12], lE:[-.55,0], rS:[-.95,-.12], rE:[-.55,0], lookY:.5, smile:.4, browAng:.15, nod:.2, holo:1, lidT:.9, set:.8 }),
      happy: P({ lS:[0,2.75], rS:[0,-2.75], lE:[0,.25], rE:[0,-.25], smile:1, open:.85, lidT:.75, lidB:.75, browUp:.8, spark:1, set:.9, jump:1 }),
      celebrate: P({ lS:[-.2,2.95], rS:[-.2,-2.95], lE:[-.9,0], rE:[-.9,0], smile:1, open:1, lidT:.8, lidB:.6, browUp:1, spark:1, set:1, jump:1.3, blush:.4 }),
      love: P({ lS:[-.9,-.28], lE:[-1.65,0], rS:[-.9,.28], rE:[-1.65,0], smile:.95, lidT:.85, lidB:.4, browUp:.5, blush:1, tilt:.14, hearts:1, set:.6 }),
      wink: P({ lS:[-.45,1.1], lE:[-1.3,.2], smile:1, wink:1, browUp:.4, tilt:.12, lean:-.03, set:.6 }),
      surprised: P({ lS:[-.4,.55], lE:[-1.4,0], rS:[-.4,-.55], rE:[-1.4,0], oh:1, smile:0, lidT:1.2, browUp:1.1, lean:-.08, nod:-.1, excl:1, set:.7 }),
      confused: P({ rS:[-.3,-2.5], rE:[-.3,-1.6], browL:.95, browAng:.12, tilt:-.22, mouthTilt:.6, smile:-.15, lookX:.4, lookY:-.3, qmark:1, set:.5 }),
      empathetic: P({ lS:[-.75,-.35], lE:[-1.1,0], rS:[-.75,.35], rE:[-1.1,0], smile:-.45, browAng:-.38, browUp:.35, lidT:.72, tilt:.18, nod:.15, blush:.25, set:.5 }),
      shy: P({ lS:[.15,.05], lE:[-.3,.5], rS:[.15,-.05], rE:[-.3,-.5], blush:1, lookX:.55, lookY:.45, tilt:.2, nod:.14, smile:.45, twist:.25, lidT:.85, set:.4 })
    };
    var state = STATES[opts.state] ? opts.state : 'idle';
    var cur = JSON.parse(JSON.stringify(STATES[state]));
    var reactTimer = null;

    // ---------------- colors
    var W = new THREE.Color(0xffffff);
    var SETTERS = {
      hair: function (c) { m.hair.color.set(c); m.shine.color.set(c).lerp(W, .5); m.brow.color.set(c).multiplyScalar(.55); },
      skin: function (c) { m.skin.color.set(c); },
      eyes: function (c) { var o = IRISM.map; IRISM.map = makeIris(c); IRISM.needsUpdate = true; if (o) o.dispose(); },
      suit: function (c) { m.suit.color.set(c); m.lapel.color.set(c).multiplyScalar(.8); },
      skirt: function (c) { m.skirt.color.set(c); },
      shirt: function (c) { m.shirt.color.set(c); },
      accent: function (c) { accentHex = '#' + new THREE.Color(c).getHexString(); glow.color.set(c); glow.emissive.set(c); micGlow.color.set(c); micGlow.emissive.set(c); voice.forEach(function (v) { v.material.color.set(c); }); waves.forEach(function (o) { o.w.material.color.set(c); }); },
      set: function (c) { m.set.color.set(c); m.cushion.color.set(c).multiplyScalar(.7); },
      shoes: function (c) { m.heels.color.set(c); }
    };
    var colors = {};
    function setColors(c) {
      if (typeof c === 'string') c = PRESETS[c] || PRESETS.liame;
      Object.keys(c || {}).forEach(function (k) { if (SETTERS[k]) { SETTERS[k](c[k]); colors[k] = c[k]; } });
      emit('colors', Object.assign({}, colors));
    }
    setColors(PRESETS.liame);
    if (opts.colors) setColors(opts.colors);
    setOutfit(opts.outfit === 'auto' ? outfitForDate(new Date()) : (opts.outfit || 'executiva'));

    // ---------------- framing / resize / pointer
    var framing = opts.framing;
    function applyFraming(f, instant) {
      framing = FRAMING[f] ? f : 'full'; var F = FRAMING[framing], narrow = container.clientWidth < 560;
      camGoal.tgt.set(F.target[0], F.target[1], F.target[2]);
      camGoal.pos.set(F.pos[0], F.pos[1], F.pos[2]); if (narrow) camGoal.pos.setLength(F.narrow);
      if (instant) { camera.position.copy(camGoal.pos); if (controls) controls.target.copy(camGoal.tgt); else camera.lookAt(camGoal.tgt); camMove = 0; } else camMove = 1.2;
    }
    var camGoal = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() }, camMove = 0, lookTarget = new THREE.Vector3();
    function resize() { var w = container.clientWidth || 300, h = container.clientHeight || 300; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    var ro = global.ResizeObserver ? new ResizeObserver(resize) : null; if (ro) ro.observe(container); resize();
    applyFraming(framing, true);
    var look = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, sAt: 1 };
    function onPointer(e) { if (!opts.lookAtPointer) return; var r = container.getBoundingClientRect(); var cx = r.left + r.width/2, cy = r.top + r.height*.35; look.tx = Math.max(-1, Math.min(1, (e.clientX - cx) / Math.max(300, r.width))); look.ty = Math.max(-1, Math.min(1, (e.clientY - cy) / Math.max(300, r.height))); }
    global.addEventListener('pointermove', onPointer, { passive: true });

    // visibility pause
    var visible = true, running = true;
    var io = (opts.pauseWhenHidden && global.IntersectionObserver) ? new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }) : null; if (io) io.observe(container);

    // ---------------- animation loop
    var clock = new THREE.Clock(), t = 0, blinkAt = 2, blink = 0, raf = 0;
    function lerpA(a, b, k) { a[0] += (b[0]-a[0])*k; a[1] += (b[1]-a[1])*k; }
    function frame() {
      raf = requestAnimationFrame(frame);
      var dt = Math.min(clock.getDelta(), .05);
      if (!running || !visible || document.hidden) return;
      t += dt; var k = 1 - Math.exp(-dt*7), tp = STATES[state];
      for (var kk in tp) { if (Array.isArray(tp[kk])) lerpA(cur[kk], tp[kk], k); else cur[kk] += (tp[kk]-cur[kk])*k; }
      var amp = opts.reducedMotion ? .3 : 1, y = 0, sq = 0, jump = 0;
      if (cur.jump > .05) { jump = (t*2.2) % 1; var h = Math.sin(jump*Math.PI); y = h*.3*amp*cur.jump; sq = ((h > .02 ? -.05*h : 0) + (jump < .12 || jump > .9 ? .07 : 0))*Math.min(1, cur.jump); }
      lia.position.y = y; lia.scale.set(1 + sq*.5, 1 - sq, 1 + sq*.5);
      hips.rotation.z = Math.sin(t*.9)*.03*amp + cur.lean; body.rotation.z = -hips.rotation.z*.6; body.rotation.y = cur.twist + Math.sin(t*.6)*.02*amp; body.scale.y = 1 + Math.sin(t*2.2)*.01*amp;
      legs.forEach(function (l) { l.rotation.z = -hips.rotation.z; });
      armL.sh.rotation.set(cur.lS[0] + Math.sin(t*1.3)*.04*amp, 0, cur.lS[1]); armL.el.rotation.set(cur.lE[0], 0, cur.lE[1]);
      armR.sh.rotation.set(cur.rS[0] + Math.sin(t*1.3+1)*.04*amp, 0, cur.rS[1]); armR.el.rotation.set(cur.rE[0], 0, cur.rE[1]);
      armL.wr.rotation.set(0, 0, 0); armR.wr.rotation.set(0, 0, 0);
      var tpR = STATES[state].rS, wantHold = propOn && tpR[0] === .05 && tpR[1] === -.2 ? 1 : 0; holdK += (wantHold - holdK)*k;
      if (holdK > .001) { armR.sh.rotation.x += (-.3 - armR.sh.rotation.x)*holdK; armR.sh.rotation.z += (-.28 - armR.sh.rotation.z)*holdK; armR.el.rotation.x += (-1.35 - armR.el.rotation.x)*holdK; armR.wr.rotation.x = .25*holdK; }
      if (state === 'wave') { armL.el.rotation.z += Math.sin(t*8)*.45*amp; armL.wr.rotation.z = Math.sin(t*8-.6)*.3*amp; }
      if (state === 'talk') { armL.sh.rotation.x += Math.sin(t*2.6)*.18*amp; armR.el.rotation.x += Math.sin(t*2.1+1)*.22*amp; }
      if (state === 'analyze') { armL.el.rotation.x += Math.sin(t*12)*.07*amp; armR.el.rotation.x += Math.sin(t*12+1.6)*.07*amp; }
      if (state === 'working') { armL.wr.rotation.x = Math.max(0, Math.sin(t*17))*.35*amp; armR.wr.rotation.x = Math.max(0, Math.sin(t*15+1.3))*.35*amp; armL.el.rotation.z += Math.sin(t*1.1)*.05; }
      if (state === 'happy') { armL.el.rotation.z += Math.sin(t*9)*.25*amp; armR.el.rotation.z -= Math.sin(t*9)*.25*amp; }
      if (state === 'celebrate') { armL.sh.rotation.z += Math.sin(t*10)*.12*amp; armR.sh.rotation.z -= Math.sin(t*10+.5)*.12*amp; }
      if (state === 'confused') { armR.wr.rotation.z = Math.sin(t*7)*.3*amp; }
      if (state === 'shy') { armL.el.rotation.z += Math.sin(t*1.5)*.08; armR.el.rotation.z -= Math.sin(t*1.5)*.08; }
      look.x += (look.tx - look.x)*k*.8; look.y += (look.ty - look.y)*k*.8;
      if (t > look.sAt) { look.sx = (Math.random()-.5)*.25; look.sy = (Math.random()-.5)*.15; look.sAt = t + .8 + Math.random()*2; }
      var lx = look.x*(state === 'working' ? .3 : 1), ly = look.y*(state === 'working' ? .3 : 1);
      hp.rotation.y = lx*.35 + Math.sin(t*.7)*.05*amp - cur.twist*.6;
      hp.rotation.x = ly*.15 + cur.nod + (state === 'talk' ? Math.sin(t*4.2)*.035 : 0) + (state === 'working' ? Math.sin(t*2.3)*.02 : 0);
      hp.rotation.z = cur.tilt + Math.sin(t*.8)*.03*amp;
      var hz = hp.rotation.z;
      spikes.forEach(function (s, i) { s.rotation.z = s.userData.b.z - hz*.25 + Math.sin(t*1.6 + i*.5)*.025*amp + (cur.jump > .05 ? Math.sin(jump*Math.PI*2)*.06 : 0); s.rotation.x = s.userData.b.x + Math.sin(t*1.2 + i*.4)*.02*amp; });
      ahoge.rotation.z = Math.sin(t*3)*.12*amp + (cur.jump > .05 ? Math.sin(jump*Math.PI*2)*.3 : 0) + (state === 'confused' ? Math.sin(t*5)*.2 : 0);
      var ex = cur.lookX + lx*.55 + look.sx, ey = cur.lookY + ly*.4 + look.sy;
      if (t > blinkAt) { blink = .18; blinkAt = t + 2.2 + Math.random()*3.2; } blink = Math.max(0, blink - dt);
      var bl = blink > 0 ? Math.abs(blink - .09)/.09 : 1;
      eyes.forEach(function (e) {
        e.ball.rotation.set(ey*.35, ex*.45, 0);
        var o = Math.min(cur.lidT, 1.2)*bl, lidB = cur.lidB;
        if (e.s < 0 && cur.wink > .02) { o = o*(1 - cur.wink); lidB = lidB*(1 - cur.wink) + .3*cur.wink; }
        e.top.rotation.x = THREE.MathUtils.lerp(Math.PI/2 + .12, -.9 - (cur.lidT > 1 ? (cur.lidT - 1)*2 : 0), Math.min(o, 1)) + ey*.15;
        e.bot.rotation.x = THREE.MathUtils.lerp(.95, 0, lidB);
        e.wl.visible = e.s < 0 && cur.wink > .6;
        var up = cur.browUp + (e.s < 0 ? cur.browL : 0) + (state === 'talk' ? Math.max(0, Math.sin(t*3.1))*.25 : 0) - (e.s < 0 ? cur.wink*.3 : 0);
        e.brow.position.y = e.baseY + up*.09; e.brow.rotation.z = e.s*(cur.browAng - .1) + (e.s < 0 ? cur.browL*.22 : 0);
      });
      var op = cur.open; if (state === 'talk') op = Math.max(0, .15 + .5*Math.abs(Math.sin(t*11)*Math.sin(t*4.3)));
      openM.visible = op > .06 && cur.oh < .3; openM.scale.set(.14 + op*.03, .02 + op*.12, .07);
      var sm = cur.smile; smile.rotation.z = sm >= 0 ? Math.PI : 0; smile.position.y = sm >= 0 ? 0 : -.06; smile.scale.set(1 - Math.abs(sm)*.15, .2 + Math.abs(sm)*.9, 1);
      smile.visible = op < .35 && cur.oh < .3;
      var ohS = cur.oh*(1 + (state === 'surprised' ? Math.sin(t*6)*.08 : 0)); ohM.visible = ohLip.visible = cur.oh > .05;
      ohM.scale.set(.06*ohS + .01, .08*ohS + .01, .04); ohLip.scale.set(.065*ohS + .01, .085*ohS + .01, .08);
      mouth.position.x = cur.mouthTilt*.1; mouth.rotation.z = -cur.mouthTilt*.35;
      m.blush.opacity = .3 + cur.blush*.45;
      // headset life
      var talkPulse = state === 'talk' ? .5 + .5*Math.abs(Math.sin(t*11)) : 0;
      micGlow.emissiveIntensity = .5 + cur.set*.6 + talkPulse*.9; glow.emissiveIntensity = .45 + cur.set*.35 + Math.sin(t*2.4)*.1;
      cups.forEach(function (c) { c.ring.scale.setScalar(1 + Math.sin(t*3)*.02*cur.set); });
      voice.forEach(function (v, i) { var ph = (t*1.4 + i*.5) % 1; v.visible = state === 'talk'; v.scale.setScalar(1 + ph*2.5); v.material.opacity = (1 - ph)*.9; });
      waves.forEach(function (o) { var ph = (t*.9 + o.i/3) % 1; o.w.visible = cur.waves > .02; o.w.scale.setScalar(1 + ph*1.6); o.w.position.y = .25 + ph*.35; o.w.material.opacity = (1 - ph)*.9*cur.waves; });
      // effects
      bub.scale.setScalar(Math.max(.001, cur.bub)); bub.visible = cur.bub > .02; bub.position.y = 3.05 + Math.sin(t*2)*.05; bub.rotation.y = Math.sin(t*.8)*.25;
      bdots.forEach(function (d, i) { if (state === 'think') { d.scale.setScalar((Math.floor(t*3) % 3) >= i ? 1 : .4); d.position.y = 0; } else { d.scale.setScalar(1); d.position.y = Math.max(0, Math.sin(t*8 - i*.9))*.05; } });
      holo.visible = cur.holo > .02; holo.scale.setScalar(Math.max(.001, cur.holo)); if (holo.visible) drawHolo(t);
      laptop.visible = cur.laptop > .02; laptop.scale.setScalar(Math.max(.001, cur.laptop)); if (laptop.visible) drawScreen(t);
      [[qSign, cur.qmark], [eSign, cur.excl]].forEach(function (p) { p[0].visible = p[1] > .03; var s = .55*p[1]*(1 + Math.sin(t*4)*.05); p[0].scale.set(s, s, 1); p[0].position.y = 2.95 + Math.sin(t*2.5)*.06; p[0].material.rotation = Math.sin(t*3)*.15; });
      hearts.forEach(function (hm) { var u = hm.userData, ph = (t*.45 + u.o) % 1; hm.visible = cur.hearts > .03; hm.position.set(Math.cos(u.a + t*.6)*1.15, 1.4 + ph*1.9, Math.sin(u.a + t*.6)*.5 + .2); hm.rotation.set(0, Math.sin(t*2 + u.a)*.5, Math.sin(t*3 + u.a)*.2); hm.scale.setScalar(.3*cur.hearts*Math.sin(ph*Math.PI) + .001); });
      spark.forEach(function (s) { var u = s.userData, ph = (t*u.s + u.o) % 1; s.visible = cur.spark > .02; s.position.set(Math.cos(u.a + t*.5)*u.r, .2 + ph*3, Math.sin(u.a + t*.5)*u.r*.6); s.rotation.set(t*3 + u.a, t*2, 0); s.material.opacity = Math.sin(ph*Math.PI)*cur.spark; });
      // outfit life
      animParticles(t); uprightProps();
      if (G.cup.visible) G.cup.userData.steam.forEach(function (sp, i) { var ph = (t*.45 + sp.userData.o) % 1; sp.position.set(Math.sin(t*2 + i*1.7)*.05*ph, -.13 + ph*.55, .1); var sc = .1 + ph*.2; sp.scale.set(sc, sc*1.3, 1); sp.material.opacity = Math.sin(ph*Math.PI)*.9; });
      if (G.bunny.visible) G.bunny.userData.ears.forEach(function (e) { var tw = Math.pow(Math.max(0, Math.sin(t*1.1 + e.s*2.3)), 40); var hop = cur.jump > .05 ? Math.sin(jump*Math.PI*2) : 0; e.g.rotation.z = e.bz + Math.sin(t*1.6 + e.s)*.06*amp - e.s*tw*.35; e.g.rotation.x = -.2 + Math.sin(t*1.3 + e.s*.7)*.04*amp; e.tip.rotation.x = .28 + Math.sin(t*2.4 + e.s*1.3)*.16*amp + hop*.45 + (state === 'empathetic' || state === 'confused' ? .6 : 0); e.tip.rotation.z = -e.s*.1 + Math.sin(t*1.9 + e.s)*.05; });
      if (G.santa.visible) G.santa.userData.tip.rotation.z = -1.45 + Math.sin(t*1.8)*.08*amp + (cur.jump > .05 ? Math.sin(jump*Math.PI*2)*.2 : 0);
      if (G.tree.visible) { G.tree.userData.orn.forEach(function (b, i) { b.material.emissiveIntensity = .12 + .5*Math.max(0, Math.sin(t*2.2 + i*1.3)); }); G.tree.userData.star.rotation.y = Math.sin(t*.8)*.4; G.tree.userData.star.material.emissiveIntensity = .5 + Math.sin(t*3)*.2; }
      if (G.flag.visible) { G.flag.userData.cloth.rotation.y = Math.sin(t*4)*.3; G.flag.userData.cloth.scale.x = 1 + Math.sin(t*6)*.04; }
      if (G.cape.visible) G.cape.rotation.x = .08 + Math.sin(t*1.7)*.04*amp + cur.jump*.15;
      // camera
      if (camMove > 0) { camMove -= dt; var kc2 = 1 - Math.exp(-dt*4); camera.position.lerp(camGoal.pos, kc2); if (controls) controls.target.lerp(camGoal.tgt, kc2); else { lookTarget.lerp(camGoal.tgt, kc2); camera.lookAt(lookTarget); } }
      if (controls) controls.update(); else if (camMove <= 0) camera.lookAt(camGoal.tgt);
      renderer.render(scene, camera);
    }
    lookTarget.copy(camGoal.tgt);
    frame();

    // ---------------- public API
    function setState(s) {
      if (!STATES[s]) { console.warn('LiaAgent: estado desconhecido', s); return api; }
      if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
      state = s; emit('state', s); return api;
    }
    var api = {
      setState: setState,
      getState: function () { return state; },
      react: function (s, ms, back) { setState(s); reactTimer = setTimeout(function () { reactTimer = null; state = back || 'idle'; emit('state', state); }, ms || 2500); return api; },
      speak: function (ms) { return api.react('talk', ms || 2000, 'idle'); },
      setColors: function (c) { setColors(c); syncSleeves(); return api; },
      setOutfit: function (id) { setOutfit(id === 'auto' ? outfitForDate(new Date()) : id); return api; },
      getOutfit: function () { return outfit; },
      getColors: function () { return Object.assign({}, colors); },
      setFraming: function (f) { applyFraming(f, false); return api; },
      snapshot: function (type) { renderer.render(scene, camera); return canvas.toDataURL(type || 'image/png'); },
      canvas: canvas,
      object3d: lia,
      pause: function () { running = false; return api; },
      resume: function () { running = true; clock.getDelta(); return api; },
      on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return api; },
      destroy: function () {
        cancelAnimationFrame(raf); global.removeEventListener('pointermove', onPointer); if (ro) ro.disconnect(); if (io) io.disconnect();
        scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (mm) { if (mm.map) mm.map.dispose(); mm.dispose(); }); } });
        renderer.dispose(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
    setTimeout(function () { emit('ready', api); }, 0);
    return api;
  }

  global.LiaAgent = { create: create, states: STATE_LIST.map(function (s) { return { id: s[0], label: s[1] }; }), presets: PRESETS, outfits: OUTFIT_LIST.map(function (o) { return { id: o[0], label: o[1], group: o[2], period: o[3] }; }), outfitForDate: outfitForDate, version: '1.4.0' };
})(typeof window !== 'undefined' ? window : this);
