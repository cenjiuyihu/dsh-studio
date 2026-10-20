const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const text = Buffer.concat(chunks).toString('utf8')
console.log(`stdin bytes=${text.length} text=${JSON.stringify(text.slice(0, 60))}`)
