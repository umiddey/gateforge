/**
 * Message-handler fixture: declares the three patterns the detector
 * recognises — `onmessage = ...`, `.on('message', handler)`, and
 * `addEventListener('message', ...)`.
 *
 * The pack's detector should emit:
 *   - task.message.onmessage (framework: 'message-handler')
 *   - task.message.message-handler (×2 from .on + addEventListener)
 */
const worker = new Worker('/worker.js');

worker.onmessage = function (event: MessageEvent): void {
  console.log(event.data);
};

worker.port.on('message', function (event: MessageEvent): void {
  console.log(event.data);
});

worker.port.addEventListener('message', function (event: MessageEvent): void {
  console.log(event.data);
});