/* Wandelt die Felder eines ausgefuellten Aufnahmebogens (Elektroverteiler Aufnahmebogen.pdf) in Plan-Daten um.
   Nutzbar in der Web-App (window.BogenImport) und in Node (require).

   BogenImport.zuPlan(felder) -> plan
     felder: { feldname: Text oder true/false }, z. B. aus pdf-lib oder pypdf
     plan:   Plan-Daten wie in Plaene/*.json; alles Unklare steht in plan.offen

   Lesart (steht so auch auf dem Bogen): Kaestchen = Schutzorgan, Linie = Stromkreis.
   "=" im Kaestchen: gehoert zum Geraet links daneben. Kaestchen leer + Linie gefuellt: LS mit dem
   Wert aus "LS ohne Angabe sind". Beides leer: freier Platz. */
(function (global) {
  'use strict';
  const REIHEN = 5, BREITE = 12;
  const KREISE = ['LS', 'SI', 'AFDD'];
  const zwei = p => String(p).padStart(2, '0');

  function isoDatum(t) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(t);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
  }

  // "b 16" -> "B16"
  function kennung(t) {
    const m = /(?:^|[^A-Z])([BCDKZE])\s*-?\s*(\d{1,3})(?!\d)/i.exec(t || '');
    return m ? m[1].toUpperCase() + m[2] : '';
  }

  // "40/0,03 A Typ A" -> { wert: "40 A / 30 mA", art: "Typ A" }
  function rcdDaten(t) {
    t = (t || '').trim();
    if (!t) return { wert: '', art: '' };
    const typ = /\bTyp\s*(AC|A|B\+|B|F|EV)\b/i.exec(t);
    const strom = /(\d{2,3})\s*A?\s*\/\s*(\d+(?:[.,]\d+)?)\s*(mA|A)?/i.exec(t);
    let wert;
    if (strom) {
      let fi = parseFloat(strom[2].replace(',', '.'));
      const einheit = (strom[3] || '').toLowerCase();
      if (einheit === 'a' || (!einheit && fi < 1)) fi = Math.round(fi * 1000);
      wert = `${strom[1]} A / ${fi} mA`;
    } else {
      wert = t.replace(/\bTyp\s*\S+/i, '').replace(/\s{2,}/g, ' ').trim();
    }
    return { wert, art: typ ? 'Typ ' + typ[1].toUpperCase() : '' };
  }

  const unsicher = (g, grund) => Object.assign(g, { unsicher: true, grund });

  // Polzahl im Kaestchen: "B16-3p", "B16 3-polig", "3xB16", "3~ B16" -> { n, rest }
  function polmarke(roh) {
    let m = /(?:^|[\s\-–\/,(])([1-4])\s*-?\s*(?:p|pol|polig)\b\.?\)?/i.exec(roh);
    if (m) return { n: Number(m[1]), rest: (roh.slice(0, m.index) + ' ' + roh.slice(m.index + m[0].length)).replace(/[\s\-–,]+$/, '').trim() };
    m = /^([1-4])\s*[x×]\s*/i.exec(roh) || /^([34])\s*~\s*/.exec(roh);
    if (m) return { n: Number(m[1]), rest: roh.slice(m[0].length).trim() };
    return null;
  }

  // Woran ein RCD im Text zu erkennen ist: "RCD", "FI", "Fehlerstrom", "40/30 mA", Hager "CDS440D" …
  const RCD_TEXT = /\b(rcd|rccb|fi|fehlerstrom\w*)\b|\bCD[A-Z]?\d{3}[A-Z]?\b|\d{2,3}\s*A?\s*\/\s*(30|300|0[.,]03|0[.,]3)\s*m?A?\b/i;

  // Inhalt eines Kaestchens -> Geraet. linie = Text auf der Linie daneben (fuer RCD-Erkennung).
  // Was unklar ist, steht als grund am Geraet (unsicher) und landet so in den offenen Punkten.
  function geraetAus(roh, std, linie) {
    roh = roh.replace(/\s+/g, ' ').trim();
    if (!roh) {
      if (std.ls) return { typ: 'LS', wert: std.ls };
      return unsicher({ typ: 'LS' }, 'Schutzorgan fehlt (oben „LS ohne Angabe sind“ ist leer)');
    }
    // nurMitMa: Text von der Linie (z. B. "CDS440D") nur als RCD-Daten nehmen, wenn ein mA-Wert drinsteht
    const rcd = (daten, extra, nurMitMa) => {
      const d = rcdDaten(daten);
      if (nurMitMa && !/mA/.test(d.wert)) d.wert = '';
      const g = Object.assign({ typ: 'RCD', wert: d.wert || std.rcd.wert, art: d.art || std.rcd.art }, extra);
      if (!g.wert) unsicher(g, 'RCD-Daten fehlen (oben „RCD ohne Angabe sind“ ist leer)');
      return g;
    };
    // Betriebsmittelkennzeichen statt Geraet, z. B. "Q1" in allen vier Kaestchen eines RCD
    const bmk = /^-?\s*([QF])\s*(\d{1,2})$/i.exec(roh);
    if (bmk) {
      const extra = { bmk: '-' + bmk[1].toUpperCase() + bmk[2], mehrfach: 4 };
      if (/haupt|^hs\b/i.test(linie)) return Object.assign({ typ: 'HS' }, extra);
      const g = rcd(RCD_TEXT.test(linie) ? linie : '', extra, true);
      if (!RCD_TEXT.test(linie)) unsicher(g, `„${roh}“ als RCD gelesen – bitte prüfen`);
      return g;
    }
    const pol = polmarke(roh);
    if (pol) {
      const g = geraetAus(pol.rest, std, linie);
      if (g.typ === 'RCD') g.pole = pol.n >= 3 ? 4 : 2;
      else g.pole = pol.n;
      g.mehrfach = g.typ === 'RCD' ? 4 : pol.n;
      return g;
    }
    if (/fi\s*\/\s*ls|rcbo/i.test(roh)) return { typ: 'FILS', wert: kennung(roh) || std.ls };
    if (/^(rcd|rccb|fi\b|fehlerstrom)/i.test(roh)) return rcd(roh.replace(/^(rcd|rccb|fi|fehlerstrom\S*)\s*/i, ''), { mehrfach: 4 });
    if (/^CD[A-Z]?\d{3}[A-Z]?\b/i.test(roh)) return rcd('', { mehrfach: 4, hinweis: roh });
    if (/^(afdd|brand)/i.test(roh)) return { typ: 'AFDD', wert: kennung(roh) || std.ls };
    if (/^sls/i.test(roh)) return { typ: 'SLS', wert: kennung(roh) || roh.replace(/^sls\s*/i, '') };
    if (/^[BCDKZ]\s*-?\s*\d{1,3}\s*A?$/i.test(roh)) return { typ: 'LS', wert: kennung(roh) };
    if (/neozed|diazed|^d0\d|^si\b|sicherung/i.test(roh)) return { typ: 'SI', wert: roh };
    if (/^(spd|überspann|ueberspann|üss|ues)/i.test(roh)) return { typ: 'SPD' };
    if (/^(hs\b|haupt)/i.test(roh)) return { typ: 'HS' };
    if (/trafo|klingel/i.test(roh)) return { typ: 'TRAFO', wert: (/\d+\s*\/\s*\d+\s*V|\d+\s*V/i.exec(roh) || [''])[0] };
    if (/sch(ü|ue)tz/i.test(roh)) return { typ: 'SCHUETZ', wert: (/\d+\s*A/i.exec(roh) || [''])[0] };
    if (/^sts\b|stromsto/i.test(roh)) return { typ: 'STS' };
    if (/uhr|zeitschalt/i.test(roh)) return { typ: 'UHR' };
    if (/kwh|z(ä|ae)hler/i.test(roh)) return { typ: 'ZAEHLER' };
    if (/steckdose|^sd$/i.test(roh)) return { typ: 'SD' };
    if (/^\d{1,3}\s*A?$/i.test(roh)) {
      return unsicher({ typ: 'LS', wert: roh.replace(/\s*A$/i, '') + ' A' }, `„${roh}“ – Auslösecharakteristik (B/C) fehlt`);
    }
    // Vertipper: N, V, G, H liegen auf der Tastatur um das B herum, X und F um das C
    const tipp = /^([NVGHXF])\s*-?\s*(\d{1,3})\s*A?$/i.exec(roh);
    if (tipp) {
      const gemeint = (/[XF]/i.test(tipp[1]) ? 'C' : 'B') + tipp[2];
      return unsicher({ typ: 'LS', wert: gemeint }, `„${roh}“ steht im Bogen – als ${gemeint} gelesen (Tippfehler?), bitte prüfen`);
    }
    return unsicher({ typ: 'SONST', wert: roh }, `„${roh}“ ist keinem Gerätetyp zugeordnet`);
  }

  // Aus dem Freitext "RCD-Zuordnung" lesen, woher Reihe `ziel` ihren Schutz bekommt.
  // Ergebnis: Reihennummer, 'ohne' oder null (nicht eindeutig)
  function reiheAusZuordnung(text, ziel) {
    for (const satz of (text || '').split(/[;\n]|\bund\b|,/i)) {
      const reihen = [...satz.matchAll(/\b(?:Reihe|R)\s*(\d)\b/gi)].map(m => Number(m[1]));
      if (!reihen.includes(ziel)) continue;
      if (/ohne/i.test(satz)) return 'ohne';
      const quelle = /RCD\s*(?:aus|in|der|von)?\s*(?:Reihe|R)\s*(\d)/i.exec(satz);
      if (quelle && Number(quelle[1]) !== ziel) return Number(quelle[1]);
    }
    return null;
  }

  function zuPlan(felder) {
    const w = {};
    // Manche Programme verschachteln Feldnamen ("formular.kunde") - es zaehlt der letzte Teil
    for (const [k, v] of Object.entries(felder || {})) w[String(k).split('.').pop()] = v;
    const t = k => (w[k] == null || w[k] === false ? '' : String(w[k])).trim();
    const an = k => w[k] === true || /^\/?(ja|on|yes|true)$/i.test(t(k));
    const offen = [];

    const netz = [an('netz_tncs') && 'TN-C-S', an('netz_tns') && 'TN-S', an('netz_tt') && 'TT'].filter(Boolean);
    if (netz.length > 1) offen.push(`Netzsystem: mehrere angekreuzt (${netz.join(', ')})`);
    const plan = {
      kunde: t('craftnote_1_customer_name') || t('craftnote_1_project_name'),
      adresse: [t('craftnote_1_project_street'),
        [t('craftnote_1_project_zipcode'), t('craftnote_1_project_city')].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      verteiler: t('verteiler'),
      standort: t('standort'),
      netz: netz.length === 1 ? netz[0] : '',
      vorsicherung: t('vorsicherung'),
      datum: isoDatum(t('datum')),
      bearbeiter: '',
      bemerkung: '',
      te_pro_reihe: BREITE,
      reihen: [],
      offen
    };
    if (t('datum') && !plan.datum) offen.push(`Datum „${t('datum')}“ nicht erkannt`);
    if (t('notizen')) plan.notizen = t('notizen');
    const std = { ls: kennung(t('ls_standard')) || t('ls_standard'), rcd: rcdDaten(t('rcd_standard')) };

    const reihen = [];
    let letzte = 0;
    for (let r = 1; r <= REIHEN; r++) {
      const geraete = [];
      for (let i = 0; i < BREITE; i++) {
        const p = (r - 1) * BREITE + i + 1;
        let s = t('s' + zwei(p));
        const linie = t('t' + zwei(p));
        const vor = geraete[geraete.length - 1];
        const anhaengen = () => {
          vor.te++;
          if (linie && !vor.text) vor.text = linie;
          else if (linie && linie !== vor.text && !(vor.hinweis || '').split(' · ').includes(linie)) {
            vor.hinweis = [vor.hinweis, linie].filter(Boolean).join(' · ');
          }
        };
        if (/^(=|"|〃|''|dito)$/i.test(s)) {
          if (vor && vor.typ !== 'LEER') { anhaengen(); continue; }
          s = '?';
        }
        // Gleicher Eintrag wie links bei einem mehrplatzigen Geraet ("Q1" × 4, "B16-3p" × 3):
        // gehoert zum selben Geraet. Gleiche einfache LS ("B16", "B16") bleiben getrennte Geraete.
        if (s && vor && vor.roh && s.replace(/\s+/g, '').toUpperCase() === vor.roh && vor.te < (vor.mehrfach || 1)) {
          anhaengen(); continue;
        }
        if (!s && !linie) {
          if (vor && vor.typ === 'LEER') vor.te++; else geraete.push({ typ: 'LEER', te: 1 });
          continue;
        }
        const g = s === '?' ? unsicher({ typ: 'SONST', wert: '?' }, '„=“ ohne Gerät links daneben') : geraetAus(s, std, linie);
        g.roh = s.replace(/\s+/g, '').toUpperCase();
        g.te = 1;
        // "Res", "Res.", "Resserve" -> "Reserve" (wird im Plan grau gesetzt)
        let text = /^res(\.|erve|serve)?$/i.test(linie) ? 'Reserve' : linie;
        if (/ohne\s*rcd/i.test(text)) {
          g.rcd = 'ohne';
          text = text.replace(/\(?\s*ohne\s*rcd\s*\)?/i, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
        }
        if (text) g.text = text;
        g.platz = p;
        geraete.push(g);
      }
      // Polzahl ergibt sich aus der Zahl der belegten Plaetze
      for (const g of geraete) {
        const angegeben = g.pole;
        if (g.typ === 'RCD') {
          g.pole = g.te >= 3 ? 4 : 2;
          if (g.te < 2) unsicher(g, 'RCD belegt nur einen Platz – „=“ in den weiteren Kästchen vergessen?');
        } else if (['LS', 'SLS', 'SI'].includes(g.typ) && (g.te > 1 || angegeben)) {
          g.pole = g.te;
          if (angegeben && angegeben !== g.te) {
            unsicher(g, `${angegeben}-polig angegeben, aber ${g.te === 1 ? 'nur 1 Platz' : g.te + ' Plätze'} ausgefüllt`);
          }
        } else if (['FILS', 'AFDD'].includes(g.typ) && g.te >= 2) g.pole = g.te >= 4 ? '3+N' : '1+N';
        if (g.pole === 1) delete g.pole;
        for (const k of ['wert', 'art']) if (g[k] === '') delete g[k];
        delete g.platz; delete g.roh; delete g.mehrfach;
      }
      while (geraete.length && geraete[geraete.length - 1].typ === 'LEER') geraete.pop();
      if (geraete.length) letzte = r;
      reihen.push({ geraete });
    }
    plan.reihen = reihen.slice(0, letzte);

    // Reihen ohne eigenen RCD: Zuordnung aus dem Bogen lesen, sonst als offen markieren
    const ersterRcd = [];
    let n = 0;
    plan.reihen.forEach((r, i) => r.geraete.forEach(g => { if (g.typ === 'RCD') { n++; if (!ersterRcd[i]) ersterRcd[i] = n; } }));
    const zuordnung = t('rcd_zuordnung');
    plan.reihen.forEach((r, i) => {
      if (ersterRcd[i]) return;
      if (!r.geraete.some(g => KREISE.includes(g.typ) && g.rcd === undefined)) return;
      const quelle = reiheAusZuordnung(zuordnung, i + 1);
      if (quelle === 'ohne') r.rcd = 'ohne';
      else if (quelle && ersterRcd[quelle - 1]) r.rcd = ersterRcd[quelle - 1];
      else {
        r.rcd = '?';
        offen.push(`Reihe ${i + 1} hat keinen eigenen RCD – welcher RCD schützt sie?` + (zuordnung ? ` (Bogen: „${zuordnung}“)` : ''));
      }
    });
    if (!plan.reihen.length) offen.push('Im Bogen sind keine Plätze ausgefüllt');
    return plan;
  }

  const api = { zuPlan, rcdDaten, kennung, isoDatum };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.BogenImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
