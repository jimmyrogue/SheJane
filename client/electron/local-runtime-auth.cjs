function installLocalRuntimeAuthorization(webRequest, { baseURL, token }) {
  const origin = new URL(baseURL).origin
  webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Authorization: `Bearer ${token}`,
      },
    })
  })
}

module.exports = { installLocalRuntimeAuthorization }
