const mode = process.argv[2];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'flood') process.stdout.write('x'.repeat(17 * 1024 * 1024));
else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (mode === 'exec') {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: input } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  } else console.log(JSON.stringify({ input, args: process.argv.slice(2) }));
}
