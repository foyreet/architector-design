(() => {
  const settings = window.AIConnection({
    async api(path, body) {
      const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-Architect-Request':'1'}, body:JSON.stringify(body)});
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      return result;
    },
    changed() {}
  });
  for (const button of document.querySelectorAll('#ai-settings, #tree-ai-settings')) {
    button.onclick = event => { event.preventDefault(); settings.open(); };
  }
})();
