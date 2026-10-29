/*
 * Pet character registry: each character provides name, dsKey(gender), and render(gender,
 * cv). Preserve shared eye and mouth IDs; cv reads CSS colors.
 */

const PET_CHARACTERS = {
  /* Default desktop appearance shares the approved transparent color logo. */
  soduwork: {
    name: 'SoduWork',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      return '<image class="soduwork-logo" href="icon.png" x="8" y="8" width="104" height="104" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>';
    }
  },
  /* SoduWork brand companion: the approved local logo with task-state feedback. */
  soduwork: {
    name: "SoduWork·品牌伙伴",
    dsKey(gender) { return "--c-ds"; },
    render(gender, cv) {
      const blue = cv("--soduwork-pet-blue") || "#4f8ff5";
      const mint = cv("--soduwork-pet-mint") || "#20c79a";
      const navy = "#203253";
      return "<defs>" +
        "<linearGradient id=\"soduWorkShell\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">" +
          "<stop offset=\"0%\" stop-color=\"#ffffff\"/>" +
          "<stop offset=\"58%\" stop-color=\"#f7faff\"/>" +
          "<stop offset=\"100%\" stop-color=\"#dfeaff\"/>" +
        "</linearGradient>" +
        "<linearGradient id=\"soduWorkEdge\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">" +
          "<stop offset=\"0%\" stop-color=\"#8fb8ff\" stop-opacity=\".92\"/>" +
          "<stop offset=\"100%\" stop-color=\"#4f8ff5\" stop-opacity=\".58\"/>" +
        "</linearGradient>" +
        "<radialGradient id=\"soduWorkHalo\" cx=\"50%\" cy=\"50%\" r=\"50%\">" +
          "<stop offset=\"52%\" stop-color=\"" + blue + "\" stop-opacity=\"0\"/>" +
          "<stop offset=\"80%\" stop-color=\"" + blue + "\" stop-opacity=\".22\"/>" +
          "<stop offset=\"100%\" stop-color=\"" + blue + "\" stop-opacity=\"0\"/>" +
        "</radialGradient>" +
        "<linearGradient id=\"soduWorkGlass\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">" +
          "<stop offset=\"0%\" stop-color=\"#ffffff\" stop-opacity=\".9\"/>" +
          "<stop offset=\"100%\" stop-color=\"#ffffff\" stop-opacity=\".08\"/>" +
        "</linearGradient>" +
      "</defs>" +
      "<circle class=\"soduwork-halo\" cx=\"60\" cy=\"61\" r=\"49\" fill=\"url(#soduWorkHalo)\"/>" +
      "<rect class=\"soduwork-shell\" x=\"22\" y=\"21\" width=\"76\" height=\"78\" rx=\"27\" fill=\"url(#soduWorkShell)\" stroke=\"url(#soduWorkEdge)\" stroke-width=\"2.2\"/>" +
      "<rect x=\"27\" y=\"26\" width=\"66\" height=\"68\" rx=\"23\" fill=\"url(#soduWorkGlass)\" stroke=\"#ffffff\" stroke-opacity=\".85\" stroke-width=\"1.1\"/>" +
      "<path class=\"soduwork-glint\" d=\"M38,32 Q49,25 61,28\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-opacity=\".82\"/>" +
      "<g class=\"soduwork-mark\" aria-label=\"SoduWork\">" +
        "<image href=\"icon.png\" x=\"34\" y=\"36\" width=\"52\" height=\"52\" preserveAspectRatio=\"xMidYMid meet\"/>" +
      "</g>" +
      "<path class=\"soduwork-smile\" d=\"M52,88 Q60,93 68,88\" fill=\"none\" stroke=\"" + navy + "\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-opacity=\".66\"/>" +
      "<circle class=\"soduwork-status-dot\" cx=\"86\" cy=\"30\" r=\"4.1\" fill=\"" + mint + "\"/>";
    }
  },

  /*
   * Expressionless glass orb with a clear center, dark rim, focused light, highlights, and
   * bubbles. Retain the bear ID for configuration and skin compatibility.
   */
  bear: {
    name: '玻璃球',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const tint = cv('--c-body')   || '#4f9be0';  /* Glass tint. */
      const rim  = cv('--c-dark')   || '#2b5a94';  /* Dark rim. */
      const halo = cv('--c-accent') || '#8fc8ff';  /* Outer glow. */
      /*
       * Scale fill opacity with glass density. The default is 1; dark skins need higher density
       * to retain saturated colors.
       */
      const dens = Math.max(.2, Math.min(2.6, parseFloat(cv('--c-density')) || 1));
      const o = (v) => Math.min(.98, +(v * dens).toFixed(3));
      return `<defs>
        <radialGradient id="gbHalo" cx="50%" cy="50%" r="50%"><stop offset="54%" stop-color="${halo}" stop-opacity="0"/><stop offset="78%" stop-color="${halo}" stop-opacity=".34"/><stop offset="100%" stop-color="${halo}" stop-opacity="0"/></radialGradient>
        <radialGradient id="gbBody" cx="41%" cy="36%" r="60%">
          <stop offset="0%" stop-color="${tint}" stop-opacity="${o(.08)}"/>
          <stop offset="44%" stop-color="${tint}" stop-opacity="${o(.24)}"/>
          <stop offset="78%" stop-color="${tint}" stop-opacity="${o(.52)}"/>
          <stop offset="94%" stop-color="${rim}" stop-opacity="${o(.8)}"/>
          <stop offset="100%" stop-color="${rim}" stop-opacity="${o(.36)}"/>
        </radialGradient>
        <radialGradient id="gbFocus" cx="50%" cy="74%" r="40%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity=".58"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="gbShade" cx="73%" cy="71%" r="66%">
          <stop offset="0%" stop-color="${rim}" stop-opacity=".48"/>
          <stop offset="45%" stop-color="${rim}" stop-opacity=".15"/>
          <stop offset="100%" stop-color="${rim}" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="gbClip"><circle cx="60" cy="61" r="38.5"/></clipPath>
      </defs>
        <circle cx="60" cy="61" r="48" fill="url(#gbHalo)"/>
        <circle cx="60" cy="61" r="39" fill="url(#gbBody)"/>
        <g clip-path="url(#gbClip)">
          <circle cx="60" cy="61" r="39" fill="url(#gbFocus)"/>
          <circle cx="60" cy="61" r="39" fill="url(#gbShade)"/>
          <circle cx="48" cy="74" r="4.6" fill="#ffffff" opacity=".5"><animate attributeName="cy" values="82;44" dur="5.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;.55;0" dur="5.5s" repeatCount="indefinite"/></circle>
          <circle cx="70" cy="78" r="3.2" fill="#ffffff" opacity=".48"><animate attributeName="cy" values="84;50" dur="6.6s" begin="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;.5;0" dur="6.6s" begin="1.6s" repeatCount="indefinite"/></circle>
          <circle cx="57" cy="64" r="2.3" fill="#ffffff" opacity=".4"/>
        </g>
        <circle cx="60" cy="61" r="39" fill="none" stroke="${rim}" stroke-width="2.4" stroke-opacity=".42"/>
        <circle cx="60" cy="61" r="38.1" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-opacity=".6"/>
        <ellipse cx="45" cy="42" rx="11" ry="15.5" fill="#ffffff" opacity=".98" transform="rotate(-26 45 42)"/>
        <circle cx="73" cy="48" r="3.4" fill="#ffffff" opacity=".62"/>
        <path d="M38,86 Q60,96 82,86" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-opacity=".4" stroke-linecap="round"/>`;
    }
  },

  /*
   * Flat orb uses solid light, body, and shadow regions with an outline. Avoid gradients and
   * feathering; retain solid bubble dots.
   */
  flatball: {
    name: '扁平球',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const body  = cv('--c-body')   || '#3b86f0';   /* Body midtone. */
      const light = cv('--c-light')  || '#7db0ff';   /* Upper-left highlight. */
      const dark  = cv('--c-dark')   || '#1d5cc0';   /* Lower-right shadow and outline. */
      const halo  = cv('--c-accent') || '#bcd9ff';   /* Outer ring. */
      /*
       * Layer solid circles from dark to body to light, offset toward the upper left, to form
       * curved spherical lighting bands.
       */
      return `<defs>
        <clipPath id="fbClip"><circle cx="60" cy="61" r="39"/></clipPath>
      </defs>
        <circle cx="60" cy="61" r="47" fill="none" stroke="${halo}" stroke-width="1.8" stroke-opacity=".5"/>
        <circle cx="60" cy="61" r="39" fill="${dark}"/>
        <g clip-path="url(#fbClip)">
          <circle cx="54" cy="55" r="34" fill="${body}"/>
          <circle cx="45" cy="44" r="27" fill="${light}"/>
          <circle cx="47" cy="74" r="4.2" fill="#ffffff" opacity=".5"><animate attributeName="cy" values="84;44" dur="5.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;.5;0" dur="5.5s" repeatCount="indefinite"/></circle>
          <circle cx="70" cy="78" r="2.9" fill="#ffffff" opacity=".45"><animate attributeName="cy" values="86;50" dur="6.6s" begin="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;.45;0" dur="6.6s" begin="1.6s" repeatCount="indefinite"/></circle>
        </g>
        <circle cx="60" cy="61" r="39" fill="none" stroke="${dark}" stroke-width="2.4"/>
        <!-- Solid white highlights without feathering. -->
        <ellipse cx="44" cy="42" rx="6.2" ry="9" fill="#ffffff" opacity=".95" transform="rotate(-28 44 42)"/>
        <circle cx="58" cy="37" r="2.6" fill="#ffffff" opacity=".75"/>`;
    }
  },








  bunny: {
    name: '奶糖小兔',
    dsKey(gender) { return '--bunny-ds'; },
    render(gender, cv) {
      const line  = cv('--bunny-line')  || '#e9cfc4';   /* Warm brown outline. */
      const earIn = cv('--bunny-earin') || '#f7b6c6';   /* Inner-ear pink. */
      const blush = cv('--bunny-blush') || '#f6aebf';   /* Blush. */
      const eye   = cv('--bunny-eye')   || '#4a3a34';   /* Warm dark-brown eyes. */
      const nose  = cv('--bunny-nose')  || '#ec93a5';
      const bow   = cv('--bunny-bow')   || '#ef8fab';
      const bowD  = cv('--bunny-bow-d') || '#e56f92';
      const isG = gender === 'girl';
      /* Female variant adds eyelashes and a bow at the left ear base. */
      const bowSvg = isG ? `<g transform="translate(44,27) rotate(-14)">
          <path d="M0,0 L-9.5,-5.4 Q-11.5,0 -9.5,5.4 Z" fill="${bow}" stroke="${bowD}" stroke-width=".8"/>
          <path d="M0,0 L9.5,-5.4 Q11.5,0 9.5,5.4 Z" fill="${bow}" stroke="${bowD}" stroke-width=".8"/>
          <circle cx="0" cy="0" r="2.6" fill="${bowD}"/></g>` : '';
      const lash = isG ? `<path d="M44.8,43.2 L42.5,41.2 M48,41.8 L47.2,39.5" stroke="${eye}" stroke-width="1.1" stroke-linecap="round"/>
        <path d="M75.2,43.2 L77.5,41.2 M74,41.8 L74.8,39.5" stroke="${eye}" stroke-width="1.1" stroke-linecap="round"/>` : '';
      return `<defs>
        <radialGradient id="bnHead" cx="42%" cy="32%" r="76%">
          <stop offset="0%" stop-color="#fffdfb"/><stop offset="58%" stop-color="#fdf1ea"/><stop offset="100%" stop-color="#f2dcd2"/>
        </radialGradient>
        <radialGradient id="bnBelly" cx="50%" cy="38%" r="70%">
          <stop offset="0%" stop-color="#fffdfb"/><stop offset="70%" stop-color="#fcf0e9"/><stop offset="100%" stop-color="#f1dbd1"/>
        </radialGradient>
        <linearGradient id="bnEar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fcf0eb"/><stop offset="100%" stop-color="#f5dcd3"/>
        </linearGradient>
      </defs>
        <ellipse cx="47" cy="17" rx="8.5" ry="18" fill="url(#bnEar)" stroke="${line}" stroke-width="1.3" transform="rotate(-9 47 17)"/>
        <ellipse cx="47.5" cy="19" rx="4.2" ry="12" fill="${earIn}" opacity=".9" transform="rotate(-9 47.5 19)"/>
        <ellipse cx="73" cy="17" rx="8.5" ry="18" fill="url(#bnEar)" stroke="${line}" stroke-width="1.3" transform="rotate(12 73 17)"/>
        <ellipse cx="72.5" cy="19" rx="4.2" ry="12" fill="${earIn}" opacity=".9" transform="rotate(12 72.5 19)"/>
        <path d="M42,80 Q38,102 48,105 L72,105 Q82,102 78,80 Q69,74 60,74 Q51,74 42,80 Z"
              fill="url(#bnBelly)" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
        <ellipse cx="60" cy="92" rx="10.5" ry="8.5" fill="#fffdfb" opacity=".85"/>
        <ellipse cx="48" cy="104.5" rx="7.2" ry="4.5" fill="#fdf3ee" stroke="${line}" stroke-width="1.2"/>
        <ellipse cx="72" cy="104.5" rx="7.2" ry="4.5" fill="#fdf3ee" stroke="${line}" stroke-width="1.2"/>
        <ellipse cx="60" cy="50" rx="30" ry="26" fill="url(#bnHead)" stroke="${line}" stroke-width="1.5"/>
        ${bowSvg}
        <ellipse cx="42" cy="59" rx="5.6" ry="3.4" fill="${blush}" opacity=".6"/>
        <ellipse cx="78" cy="59" rx="5.6" ry="3.4" fill="${blush}" opacity=".6"/>
        <g class="lid" id="lidL">
          <ellipse id="pupL" cx="49" cy="48" rx="4.8" ry="5.6" fill="${eye}"/>
          <circle id="shL" cx="50.9" cy="46" r="1.8" fill="#fff" opacity=".95"/>
          <circle cx="47.7" cy="50.2" r=".85" fill="#fff" opacity=".7"/>
        </g>
        <g class="lid" id="lidR">
          <ellipse id="pupR" cx="71" cy="48" rx="4.8" ry="5.6" fill="${eye}"/>
          <circle id="shR" cx="72.9" cy="46" r="1.8" fill="#fff" opacity=".95"/>
          <circle cx="69.7" cy="50.2" r=".85" fill="#fff" opacity=".7"/>
        </g>
        ${lash}
        <path d="M57.1,56 Q60,54.1 62.9,56 Q60,59.6 57.1,56 Z" fill="${nose}"/>
        <path id="petMouth" d="M60,58.4 Q57.5,61.6 54.2,60.3 M60,58.4 Q62.5,61.6 65.8,60.3" stroke="#c98d90" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <rect x="57.8" y="59.4" width="4.4" height="3.5" rx="1.6" fill="#fff" stroke="#dfc2b8" stroke-width=".8"/>
        <circle cx="52" cy="84" r="4.3" fill="#fdf4ef" stroke="${line}" stroke-width="1.3"/>
        <circle cx="68" cy="84" r="4.3" fill="#fdf4ef" stroke="${line}" stroke-width="1.3"/>
        <path d="M52,81.8 v2.2 M68,81.8 v2.2" stroke="#ead0c6" stroke-width="1" stroke-linecap="round"/>`;
    }
  },

  /* Expressionless gift box with a white body and a four-color lid. */
  box: {
    name: '彩色盒子',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const front  = cv('--c-light') || '#ffffff';   /* Front face. */
      const frontB = cv('--c-body')  || '#e9edf4';
      const side   = cv('--c-side')  || '#d0d8e5';   /* Right-side shadow. */
      const line   = cv('--c-dark')  || '#93a0b5';
      const glow   = cv('--c-glow')  || '#ffb877';   /* Ground glow. */
      /*
       * Lid-edge shading defaults to navy; red lids need a warm dark-red override to avoid muddy
       * purple edges.
       */
      const shade  = cv('--c-shade') || '#0b1c30';
      /*
       * Read lid colors from --boxlid-* so the pet and panel lids match. Do not reuse --box-c*
       * tokens, which encode task status.
       */
      const c = [
        cv('--boxlid-1') || '#ff9f2e',
        cv('--boxlid-2') || '#4f8ff5',
        cv('--boxlid-3') || '#1ec79b',
        cv('--boxlid-4') || '#ef5f92'
      ];
      const topOutline = 'M28,48 L44,35 L92,35 L76,48 Z';
      /* Draw four perspective-aligned color bands across the lid. */
      const segs = [
        'M28,48 L44,35 L56,35 L40,48 Z',
        'M40,48 L56,35 L68,35 L52,48 Z',
        'M52,48 L68,35 L80,35 L64,48 Z',
        'M64,48 L80,35 L92,35 L76,48 Z'
      ].map((d, i) => `<path d="${d}" fill="${c[i]}"/>`).join('');
      return `<defs>
        <linearGradient id="cbFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${front}"/><stop offset="100%" stop-color="${frontB}"/></linearGradient>
        <radialGradient id="cbGlow" cx="50%" cy="60%" r="58%"><stop offset="60%" stop-color="${glow}" stop-opacity="0"/><stop offset="100%" stop-color="${glow}" stop-opacity=".2"/></radialGradient>
      </defs>
        <ellipse cx="60" cy="68" rx="46" ry="40" fill="url(#cbGlow)"/>
        <!-- Box body: shaded right face and white front. -->
        <path d="M76,54 L92,41 L92,79 L76,92 Z" fill="${side}" stroke="${line}" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M28,54 L76,54 L76,92 L28,92 Z" fill="url(#cbFront)" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M31,59 L73,59" stroke="#ffffff" stroke-width="1.3" stroke-opacity=".5" stroke-linecap="round"/>
        <!-- Four-color lid surface. -->
        ${segs}
        <!-- Four-color front rim shows lid thickness. -->
        <rect x="28" y="48" width="12" height="6.4" fill="${c[0]}"/>
        <rect x="40" y="48" width="12" height="6.4" fill="${c[1]}"/>
        <rect x="52" y="48" width="12" height="6.4" fill="${c[2]}"/>
        <rect x="64" y="48" width="12" height="6.4" fill="${c[3]}"/>
        <rect x="28" y="48" width="48" height="6.4" fill="${shade}" opacity=".13"/>
        <!-- Shaded right rim. -->
        <path d="M76,48 L92,35 L92,41.4 L76,54.4 Z" fill="${c[3]}"/>
        <path d="M76,48 L92,35 L92,41.4 L76,54.4 Z" fill="${shade}" opacity=".3"/>
        <!-- Outline. -->
        <path d="${topOutline}" fill="none" stroke="${line}" stroke-width="1.2" stroke-linejoin="round" stroke-opacity=".7"/>
        <path d="M28,54.4 L76,54.4 L92,41.4 M76,48 L76,54.4" fill="none" stroke="${line}" stroke-width="1" stroke-linejoin="round" stroke-opacity=".42"/>`;
    }
  },

  /* Crystal gift box with faceted sides, a refractive lid, and sparkling highlights. */
  diamond: {
    name: '钻石盒子',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const line = 'rgba(122,172,222,.72)';
      return `<defs>
        <linearGradient id="dmFront" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0%" stop-color="#effaff"/><stop offset="55%" stop-color="#d3ecff"/><stop offset="100%" stop-color="#bfe0fb"/></linearGradient>
        <linearGradient id="dmTop" x1="0" y1="0" x2="1" y2="0.2"><stop offset="0%" stop-color="#a6e4ff"/><stop offset="30%" stop-color="#bfccff"/><stop offset="54%" stop-color="#d8c2fb"/><stop offset="78%" stop-color="#b4ebef"/><stop offset="100%" stop-color="#a2e2ff"/></linearGradient>
        <radialGradient id="dmGlow" cx="50%" cy="54%" r="60%"><stop offset="56%" stop-color="#aadcff" stop-opacity="0"/><stop offset="100%" stop-color="#aadcff" stop-opacity=".28"/></radialGradient>
      </defs>
        <ellipse cx="60" cy="66" rx="47" ry="42" fill="url(#dmGlow)"/>
        <path d="M28,48 L44,33 L92,33 L76,48 Z" fill="url(#dmTop)" stroke="${line}" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M44,33 L51,48 M60.5,33 L60.5,48 M76,33 L69,48" stroke="#ffffff" stroke-width=".9" stroke-opacity=".5"/>
        <path d="M76,48 L92,33 L92,75 L76,90 Z" fill="#a9cdec" stroke="${line}" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M84,40 L84,82" stroke="#ffffff" stroke-width=".9" stroke-opacity=".28"/>
        <path d="M28,48 L76,48 L76,90 L28,90 Z" fill="url(#dmFront)" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M28,48 L52,68 L28,90 M76,48 L52,68 L76,90 M52,68 L52,90" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-opacity=".5" stroke-linejoin="round"/>
        <path d="M40,48 L52,59 L64,48" fill="none" stroke="#ffffff" stroke-width=".9" stroke-opacity=".42"/>
        <path d="M32,51 L44,51 L37,63 Z" fill="#ffffff" opacity=".45"/>
        <path d="M66,58 l1.7,4.3 4.3,1.7 -4.3,1.7 -1.7,4.3 -1.7,-4.3 -4.3,-1.7 4.3,-1.7 Z" fill="#ffffff" opacity=".9"/>
        <circle cx="38" cy="82" r="1.5" fill="#ffffff" opacity=".7"/>
        <circle cx="83" cy="52" r="1.2" fill="#ffffff" opacity=".6"/>`;
    }
  },

  /* Cat with triangular ears, tabby stripes, a triangular nose, and whiskers. */
  cat: {
    name: '小猫',
    dsKey(gender) { return gender === 'girl' ? '--c-ds-g' : '--c-ds'; },
    render(gender, cv) {
      const body = cv('--c-body') || '#e8a87c';
      const dark = cv('--c-dark') || '#b87a55';
      const ear  = cv('--c-ear')  || '#d4936a';
      const pink = cv('--c-accent')||'#e8719a';
      const stripe = dark;
      const isG = gender === 'girl';
      const bow = isG ? `<g transform="translate(60,20)"><path d="M0,0 L-9,-5 L-9,5 Z" fill="${pink}"/><path d="M0,0 L9,-5 L9,5 Z" fill="${pink}"/><circle cx="0" cy="0" r="2.5" fill="${cv('--c-accent-d')||'#d0568a'}"/></g>` : '';
      return `<defs><radialGradient id="catG" cx="40%" cy="35%"><stop offset="0%" stop-color="#f5c9a8"/><stop offset="100%" stop-color="${body}"/></radialGradient></defs>
        <path d="M26,40 L34,8 L52,36 Z" fill="${ear}"/><path d="M32,34 L36,16 L46,32 Z" fill="${pink}" opacity=".6"/>
        <path d="M68,36 L86,8 L94,40 Z" fill="${ear}"/><path d="M74,32 L84,16 L88,34 Z" fill="${pink}" opacity=".6"/>
        ${bow}
        <circle cx="60" cy="64" r="36" fill="url(#catG)"/>
        <path d="M48,40 Q52,36 56,40" stroke="${stripe}" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".5"/>
        <path d="M64,40 Q68,36 72,40" stroke="${stripe}" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".5"/>
        <path d="M56,46 L60,50 L64,46" stroke="${stripe}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".4"/>
        <g class="lid" id="lidL"><ellipse id="pupL" cx="48" cy="60" rx="4.5" ry="6" fill="${dark}"/><circle id="shL" cx="50" cy="58" r="1.5" fill="#fff" opacity=".9"/></g>
        <g class="lid" id="lidR"><ellipse id="pupR" cx="72" cy="60" rx="4.5" ry="6" fill="${dark}"/><circle id="shR" cx="74" cy="58" r="1.5" fill="#fff" opacity=".9"/></g>
        <path d="M57,72 L60,69 L63,72 Z" fill="${pink}"/>
        <path id="petMouth" d="M60,73 Q56,78 52,76 M60,73 Q64,78 68,76" stroke="${dark}" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <g stroke="${dark}" stroke-width="1" opacity=".5" stroke-linecap="round">
          <line x1="24" y1="66" x2="38" y2="68"/><line x1="24" y1="72" x2="38" y2="72"/>
          <line x1="82" y1="68" x2="96" y2="66"/><line x1="82" y1="72" x2="96" y2="72"/>
        </g>`;
    }
  },

  /* Robot with a rounded head, LED face, antenna, speaker ears, and base. */
  robot: {
    name: '机器人',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const body = cv('--c-body') || '#7a8a9a';
      const dark = cv('--c-dark') || '#5a6a7a';
      const scr  = cv('--c-accent')|| '#1a2a3a';
      const led  = cv('--c-light') || '#5dc59a';
      const isG = gender === 'girl';
      const cheek = isG ? `<circle cx="34" cy="62" r="4" fill="${cv('--c-accent-d')||'#e8719a'}" opacity=".4"/><circle cx="86" cy="62" r="4" fill="${cv('--c-accent-d')||'#e8719a'}" opacity=".4"/>` : '';
      return `<defs><linearGradient id="robG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${cv('--c-light')||'#9aabbf'}"/><stop offset="100%" stop-color="${body}"/></linearGradient></defs>
        <line x1="60" y1="20" x2="60" y2="10" stroke="${dark}" stroke-width="2" stroke-linecap="round"/>
        <circle cx="60" cy="8" r="4" fill="${led}"><animate attributeName="opacity" values="1;.4;1" dur="2s" repeatCount="indefinite"/></circle>
        <rect x="14" y="44" width="10" height="20" rx="3" fill="${dark}"/>
        <rect x="96" y="44" width="10" height="20" rx="3" fill="${dark}"/>
        <circle cx="19" cy="54" r="3" fill="${body}"/><circle cx="101" cy="54" r="3" fill="${body}"/>
        <rect x="22" y="20" width="76" height="68" rx="16" fill="url(#robG)" stroke="${dark}" stroke-width="1.5"/>
        <rect x="32" y="32" width="56" height="34" rx="8" fill="${scr}"/>
        <g class="lid" id="lidL"><circle id="pupL" cx="48" cy="49" r="4" fill="${led}"/><circle id="shL" cx="49" cy="48" r="1.5" fill="#fff" opacity=".7"/></g>
        <g class="lid" id="lidR"><circle id="pupR" cx="72" cy="49" r="4" fill="${led}"/><circle id="shR" cx="73" cy="48" r="1.5" fill="#fff" opacity=".7"/></g>
        <rect id="petMouth" x="52" y="58" width="16" height="3" rx="1.5" fill="${led}" opacity=".8"/>
        ${cheek}
        <path d="M30,88 L90,88 L86,96 L34,96 Z" fill="${dark}"/>
        <rect x="40" y="91" width="6" height="2" rx="1" fill="${led}" opacity=".6"/>
        <rect x="50" y="91" width="6" height="2" rx="1" fill="${led}" opacity=".6"/>
        <rect x="60" y="91" width="6" height="2" rx="1" fill="${led}" opacity=".6"/>
        <rect x="70" y="91" width="6" height="2" rx="1" fill="${led}" opacity=".6"/>`;
    }
  },

  /* Water droplet with ripples and transparent highlights. */
  drop: {
    name: '水滴',
    dsKey(gender) { return gender === 'girl' ? '--c-ds-g' : '--c-ds'; },
    render(gender, cv) {
      const body = cv('--c-body') || '#6fc3e8';
      const dark = cv('--c-dark') || '#4a9dc7';
      const hi   = cv('--c-light') || '#b8e0f5';
      const isG = gender === 'girl';
      const lash = isG ? `<path d="M44,55 L41,52 M50,53 L49,50" stroke="${dark}" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M70,55 L73,52 M64,53 L65,50" stroke="${dark}" stroke-width="1.2" stroke-linecap="round"/>` : '';
      return `<defs><linearGradient id="dropG" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="${hi}"/><stop offset="60%" stop-color="${body}"/><stop offset="100%" stop-color="${dark}"/>
      </linearGradient></defs>
        <path d="M60,14 C60,14 28,48 28,74 C28,94 42,104 60,104 C78,104 92,94 92,74 C92,48 60,14 60,14 Z" fill="url(#dropG)" opacity=".92"/>
        <path d="M60,14 C60,14 28,48 28,74 C28,94 42,104 60,104 C78,104 92,94 92,74 C92,48 60,14 60,14 Z" fill="none" stroke="${dark}" stroke-width="1.2" opacity=".4"/>
        <ellipse cx="44" cy="58" rx="6" ry="14" fill="${hi}" opacity=".5" transform="rotate(-15 44 58)"/>
        ${lash}
        <g class="lid" id="lidL"><circle id="pupL" cx="49" cy="62" r="5" fill="${dark}"/><circle id="shL" cx="51" cy="60" r="2" fill="#fff" opacity=".85"/></g>
        <g class="lid" id="lidR"><circle id="pupR" cx="71" cy="62" r="5" fill="${dark}"/><circle id="shR" cx="73" cy="60" r="2" fill="#fff" opacity=".85"/></g>
        <path id="petMouth" d="M54,78 Q60,83 66,78" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/>
        <ellipse cx="60" cy="96" rx="24" ry="4" fill="none" stroke="${hi}" stroke-width="1.5" opacity=".6"/>
        <ellipse cx="60" cy="100" rx="18" ry="3" fill="none" stroke="${hi}" stroke-width="1" opacity=".4"/>`;
    }
  },

  /* Minimal orb with a glowing ring, dashed inner ring, facial lines, and status light. */
  orb: {
    name: '光球',
    dsKey(gender) { return '--c-ds'; },
    render(gender, cv) {
      const ring = cv('--c-body') || '#7c6cf0';
      const glow = cv('--c-accent')|| '#a59cff';
      const dark = cv('--c-dark') || '#5a4abf';
      const led  = cv('--c-light') || '#5dc59a';
      const isG = gender === 'girl';
      const accent = isG ? `<circle cx="60" cy="30" r="3" fill="${cv('--c-accent-d')||'#e8719a'}" opacity=".7"/>` : '';
      return `<defs>
        <radialGradient id="orbGlow" cx="50%" cy="50%"><stop offset="0%" stop-color="${glow}" stop-opacity=".4"/><stop offset="70%" stop-color="${glow}" stop-opacity="0"/></radialGradient>
        <radialGradient id="orbFill" cx="50%" cy="40%"><stop offset="0%" stop-color="${glow}" stop-opacity=".15"/><stop offset="100%" stop-color="${ring}" stop-opacity=".05"/></radialGradient>
      </defs>
        <circle cx="60" cy="60" r="44" fill="url(#orbGlow)"><animate attributeName="r" values="42;46;42" dur="3s" repeatCount="indefinite"/></circle>
        <circle cx="60" cy="60" r="36" fill="url(#orbFill)" stroke="${ring}" stroke-width="2.5"/>
        <circle cx="60" cy="60" r="28" fill="none" stroke="${ring}" stroke-width="1" stroke-dasharray="3 4" opacity=".5">
          <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="20s" repeatCount="indefinite"/>
        </circle>
        <circle cx="60" cy="18" r="3" fill="${led}"><animate attributeName="opacity" values="1;.3;1" dur="1.5s" repeatCount="indefinite"/></circle>
        ${accent}
        <g class="lid" id="lidL"><line id="pupL" x1="44" y1="56" x2="52" y2="56" stroke="${dark}" stroke-width="2.5" stroke-linecap="round"/><circle id="shL" cx="50" cy="55" r="1.2" fill="#fff" opacity=".6"/></g>
        <g class="lid" id="lidR"><line id="pupR" x1="68" y1="56" x2="76" y2="56" stroke="${dark}" stroke-width="2.5" stroke-linecap="round"/><circle id="shR" cx="74" cy="55" r="1.2" fill="#fff" opacity=".6"/></g>
        <path id="petMouth" d="M52,72 Q60,78 68,72" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    }
  }
};

/* Register built-in characters in SkinRegistry for unified lookup. */
(function registerBuiltinChars() {
  if (typeof SkinRegistry === 'undefined') return;
  Object.keys(PET_CHARACTERS).forEach(id => {
    SkinRegistry.registerCharacter(id, PET_CHARACTERS[id]);
  });
})();

/* Resolve built-in characters first, then SkinRegistry entries including remote characters. */
function _getCharDef(characterId) {
  const fallback = PET_CHARACTERS.bear;
  if (!characterId) return fallback;
  if (PET_CHARACTERS[characterId]) return PET_CHARACTERS[characterId];
  if (typeof SkinRegistry !== 'undefined') {
    const custom = SkinRegistry.getCharacter(characterId);
    if (custom) return custom;
  }
  return fallback;
}

/* Render the character selected by cfg.character. */
function renderPetSVG(gender) {
  const petSvg = document.getElementById('petSvg');
  if (!petSvg) return;
  const ch = _getCharDef(cfg.character);
  const cv = (v) => {
    const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return val || '';
  };
  let html;
  try {
    html = ch.render(gender || cfg.gender || 'boy', cv);
  } catch (e) {
    console.error('[renderPetSVG] render failed, fallback bear', e);
    html = PET_CHARACTERS.bear.render(gender || cfg.gender || 'boy', cv);
  }
  // Task heartbeats don't change the character. Replacing identical SVG resets
  // its animations/filters and repaints the transparent native surface.
  if (petSvg._renderedCharacter !== html) {
    petSvg.innerHTML = html;
    petSvg._renderedCharacter = html;
  }
}

/* Read the current character's shadow color. */
function getPetShadowColor(gender) {
  const ch = _getCharDef(cfg.character);
  const key = ch.dsKey(gender || cfg.gender || 'boy');
  return getComputedStyle(document.documentElement).getPropertyValue(key).trim() || 'rgba(0,0,0,.22)';
}
