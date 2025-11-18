(function () {
    const TARGET = /GetMetadata|GeoPhotoService/i;

    function post(payload) {
        try {
            window.postMessage({
                source: "geo-sniffer",
                type: "GEO_META",
                payload
            }, "*");
        } catch (e) {
            // ignore
        }
    }

    // Hook XHR
    try {
        const OriginalXHR = window.XMLHttpRequest;
        function PatchedXHR() {
            const xhr = new OriginalXHR();
            const _open = xhr.open;
            const _send = xhr.send;

            let requestURL = "";
            let requestMethod = "GET";

            xhr.open = function (method, url, async, user, pass) {
                requestURL = url;
                requestMethod = method || "GET";
                return _open.apply(this, arguments);
            };

            xhr.send = function (data) {
                if (requestURL && TARGET.test(requestURL)) {
                    const onLoad = () => {
                        try {
                            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                                const text = xhr.responseType === "" || xhr.responseType === "text"
                                    ? (xhr.responseText || "")
                                    : "";
                                post({
                                    url: requestURL,
                                    method: requestMethod,
                                    response: String(text || ""),
                                    status: xhr.status,
                                    timestamp: Date.now(),
                                    hookType: "xhr"
                                });
                            }
                        } catch (e) { }
                    };
                    xhr.addEventListener("load", onLoad, { once: false });
                    const _onreadystatechange = xhr.onreadystatechange;
                    xhr.onreadystatechange = function () {
                        try { onLoad(); } catch (_) { }
                        if (typeof _onreadystatechange === "function") {
                            return _onreadystatechange.apply(this, arguments);
                        }
                    };
                }
                return _send.apply(this, arguments);
            };

            return xhr;
        }
        PatchedXHR.prototype = OriginalXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;
    } catch (e) {
    }

    try {
        const originalFetch = window.fetch;
        window.fetch = function (...args) {
            const [resource, config] = args;
            const url = typeof resource === "string" ? resource : (resource && resource.url);
            const method = (config && config.method) || "GET";

            if (url && TARGET.test(url)) {
                return originalFetch.apply(this, args).then((resp) => {
                    try {
                        const clone = resp.clone();
                        clone.text().then((text) => {
                            post({
                                url,
                                method,
                                response: String(text || ""),
                                status: resp.status,
                                timestamp: Date.now(),
                                hookType: "fetch"
                            });
                        }).catch(() => { });
                    } catch (e) { }
                    return resp;
                });
            }
            return originalFetch.apply(this, args);
        };
    } catch (e) {
    }
    try {
        const _text = Response.prototype.text;
        Response.prototype.text = function () {
            return _text.call(this).then((t) => {
                try {
                    if (this.url && TARGET.test(this.url)) {
                        post({
                            url: this.url,
                            method: "UNKNOWN",
                            response: String(t || ""),
                            status: this.status,
                            timestamp: Date.now(),
                            hookType: "response.text"
                        });
                    }
                } catch (_) { }
                return t;
            });
        };
    } catch (e) {
    }
})();
