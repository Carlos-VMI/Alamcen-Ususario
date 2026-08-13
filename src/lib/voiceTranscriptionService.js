export async function transcribeAudioWithWhisper(audioBlob) {
  const endpoint = import.meta.env.VITE_WHISPER_ENDPOINT;
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

  if (!endpoint && !apiKey) {
    return '';
  }

  const formData = new FormData();
  formData.append('file', audioBlob, 'pick-audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('language', 'es');

  const targetUrl = endpoint || 'https://api.openai.com/v1/audio/transcriptions';
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: formData
  });

  if (!response.ok) {
    throw new Error('No se pudo transcribir el audio');
  }

  const data = await response.json();
  return String(data.text || '').trim();
}
