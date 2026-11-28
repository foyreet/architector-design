// Load the local renderer and its Cyrillic fonts only when a document is exported.
import './vendor/pdfmake-0.3.15.min.js';
import './vendor/pdfmake-roboto-0.3.15.js';

function inline(node, inherited = {}) {
  if (node.nodeType === Node.TEXT_NODE) return [{...inherited, text:node.textContent}];
  if (node.tagName === 'BR') return [{...inherited, text:'\n'}];
  const run = {...inherited};
  switch (node.tagName) {
    case 'STRONG': run.bold = true; break;
    case 'EM': run.italics = true; break;
    case 'DEL': run.decoration = 'lineThrough'; break;
    case 'CODE': run.background = '#edf1f6'; break;
    case 'A':
      if (!node.closest('.section-sources')) {
        run.link = node.href;
        run.color = '#214f9b';
        run.decoration = 'underline';
      }
      break;
  }
  return Array.from(node.childNodes).flatMap(child => inline(child, run));
}

function blocks(parent) {
  const result = [];
  let runs = [];
  function flush() {
    if (runs.length) result.push({text:runs, margin:[0, 0, 0, 5]});
    runs = [];
  }
  for (const node of parent.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent) continue;
    const tag = node.tagName;
    if (!tag || ['STRONG','EM','DEL','CODE','BR','A','SPAN'].includes(tag)) {
      runs = runs.concat(inline(node));
      continue;
    }
    flush();
    if (/^H[1-6]$/.test(tag)) {
      result.push({text:inline(node), headlineLevel:3, bold:true, fontSize:12, margin:[0, 5, 0, 3]});
    } else if (tag === 'UL' || tag === 'OL') {
      const list = {[tag.toLowerCase()]:Array.from(node.children, li => ({stack:blocks(li)})), margin:[0, 0, 0, 4]};
      if (tag === 'OL') list.start = node.start;
      result.push(list);
    } else if (tag === 'TABLE') {
      const rows = Array.from(node.rows, row => Array.from(row.cells, cell => ({
        text:inline(cell), bold:cell.tagName === 'TH', alignment:cell.style.textAlign || 'left',
        fillColor:cell.tagName === 'TH' ? '#eef2f7' : null
      })));
      if (rows.length && rows[0].length) {
        const count = rows[0].length;
        // Split very wide tables into column groups so cells remain readable on A4.
        for (let start = 0; start < count; start += 5) {
          const body = rows.map(row => row.slice(start, start + 5));
          const widths = body[0].map(() => (100 / body[0].length) + '%');
          result.push({table:{headerRows:1, widths, body}, layout:'lightHorizontalLines', fontSize:9, margin:[0, 3, 0, 7]});
        }
      }
    } else if (tag === 'BLOCKQUOTE') {
      result.push({stack:blocks(node), margin:[14, 2, 0, 5], color:'#475569', italics:true});
    } else if (tag === 'PRE') {
      result.push({text:node.textContent, fontSize:9, preserveLeadingSpaces:true, margin:[10, 3, 0, 7]});
    } else if (tag === 'HR') {
      result.push({canvas:[{type:'line', x1:0, y1:0, x2:100, y2:0, lineColor:'#a5b3c5'}], margin:[0, 4, 0, 8]});
    } else if (tag === 'SUMMARY') {
      result.push({text:inline(node), bold:true, margin:[0, 4, 0, 3]});
    } else {
      result.push(...blocks(node));
    }
  }
  flush();
  return result;
}

export async function downloadDocument(title, sections) {
  const content = [{text:title, headlineLevel:1, fontSize:23, bold:true, margin:[0, 0, 0, 12]}];
  for (const [index, section] of sections.entries()) {
    content.push({text:(index + 1) + '. ' + section.heading, headlineLevel:2, fontSize:15,
      bold:true, margin:[0, 12, 0, 6]});
    if (section.markdown.trim()) content.push(...blocks(window.ChatMarkdown(section.markdown)));
    else content.push({text:'Не заполнено', color:'#64748b'});
    if (section.evidence) content.push({stack:blocks(section.evidence), fontSize:9, color:'#475569', margin:[12, 5, 0, 3]});
  }
  const definition = {
    info:{title}, pageSize:'A4', pageMargins:[48, 44, 48, 48], content,
    defaultStyle:{font:'Roboto', fontSize:11, lineHeight:1.22, color:'#202d40'},
    footer:(page, total) => ({text:page + ' / ' + total, alignment:'right', fontSize:9, color:'#566477', margin:[0, 10, 48, 0]}),
    pageBreakBefore:(node, page) => Boolean(node.headlineLevel) && page.getFollowingNodesOnPage().length === 0
  };
  const name = Array.from(title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 100).join('').trim();
  await window.pdfMake.createPdf(definition).download((name || 'Дизайн-документ') + '.pdf');
}
