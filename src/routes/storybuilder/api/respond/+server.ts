import type { RequestHandler } from './$types';
import { handleUserMessageStream, SupersededError } from '$lib/server/interview';

export const POST: RequestHandler = async ({ locals, request }) => {
  const session = await locals.getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { sessionId, message } = await request.json();
    if (!sessionId || !message) {
      return new Response(JSON.stringify({ error: 'sessionId and message are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use ReadableStream for SSE streaming
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const writer = {
          write: (data: string) => {
            controller.enqueue(encoder.encode(data));
          },
          end: () => {
            controller.close();
          }
        };

        try {
          await handleUserMessageStream(sessionId, message, writer, locals.supabase);
        } catch (err: any) {
          if (err instanceof SupersededError) {
            // Not a failure: another tab took this story over. The client ends
            // itself quietly (in-page card, no dialog, no TTS).
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'superseded', heldBy: err.heldBy })}\n\n`)
            );
            controller.close();
            return;
          }
          console.error('Error streaming message:', err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)
          );
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  } catch (err: any) {
    console.error('Error in respond endpoint:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
