FROM python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 AS sources

ADD --checksum=sha256:1c89f2f1e0bee93742cff8de9181fc07c702ce0651f1492bb3b97487d3a84af1 https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.332.tgz /tmp/claude.tgz
ADD --checksum=sha256:8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 /out/bin/ttyd
ADD --checksum=sha256:8b7e100f8311cb428c57609164d93099bada2599f948359045d1ac876a7a625b https://raw.githubusercontent.com/tsl0922/ttyd/1.7.7/LICENSE /out/licenses/ttyd
RUN mkdir -p /out/bin /out/licenses \
 && tar -xOzf /tmp/claude.tgz package/claude > /out/bin/claude \
 && tar -xOzf /tmp/claude.tgz package/LICENSE.md > /out/licenses/claude-code \
 && chmod 0755 /out/bin/claude /out/bin/ttyd

FROM python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285

COPY --from=sources /out/bin/ /usr/local/bin/
COPY --from=sources /out/licenses/ /usr/share/doc/hivra-claude-terminal/
COPY --chmod=0755 start-terminal /usr/local/bin/start-claude-terminal
COPY readiness.py /usr/local/lib/hivra-claude-readiness.py

ENV HOME=/workspace/.agent-home \
    DISABLE_AUTOUPDATER=1
WORKDIR /workspace
USER 65534:65534
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=3 CMD ["python3", "-I", "/usr/local/lib/hivra-claude-readiness.py"]
ENTRYPOINT ["/usr/local/bin/start-claude-terminal"]
