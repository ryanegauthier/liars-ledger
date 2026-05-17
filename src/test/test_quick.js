const body = {
    model: "qwen2.5:1.5b",
    stream: false,
    messages: [{
      role: "user",
      content: "Read this article and return JSON only, no markdown:\n\nSenator Bernie Sanders said he supports Medicare for All.\n\nReturn: {\"figures\":[{\"lookup_name\":\"Sen. Sanders\",\"claim\":\"one sentence\",\"search_terms\":[\"term1\",\"term2\"]}]}"
    }]
  };
  
  fetch("http://100.67.253.3:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json()).then(d => console.log(d?.message?.content)).catch(console.error);