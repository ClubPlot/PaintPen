

const DSC = {
    OutputBufferSpace: "\x1b.B",
    OutputIdentification: "\x1b.A",
} as const;

function createConnection(url: string | URL) {

    /* Receive Queue */

    let controller!: ReadableStreamDefaultController<string>;

    const incoming = new ReadableStream<string>({
        start(c) { controller = c }
    });

    const ws = new WebSocket(url);

    ws.addEventListener('error', (ev) => {
        console.log(ev);
    });

    ws.addEventListener('message', ({ data }) => controller.enqueue(data));
    ws.addEventListener('close', () => controller.close());

    const reader = incoming.getReader();

    /* Readiness */

    const { promise, resolve, reject } = Promise.withResolvers<true>();

    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
        resolve(true);
        ws.removeEventListener('error', reject);
    });

    return {
        ready() {
            return promise;
        },
        read() {
            return reader.read();
        },
        write(data: string) {
            ws.send(data);
        }
    }
}

const connection = createConnection("ws://10.100.5.213:8080");


// Plot a string and then have it be sent back

// async function plot(code: string): Promise<string> {
//     await connection.ready();

//     connection.write(code);

//     /* ... */
// }

// async function init() {
//     await connection.ready();
//     connection.write(DSC.OutputIdentification);
// }

/*

BUF 45              # Buffer progress report
OK  768             # Total bytes written at end of itsaliveplot loop
RAW ''''

*/
