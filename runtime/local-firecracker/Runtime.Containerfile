ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
ARG VMM_FILE
ARG KERNEL_FILE
ARG ROOT_FILE
ARG STATE_FILE
ARG RUNTIME_REVISION
COPY --from=vmm /${VMM_FILE} /firecracker
COPY --from=kernel /${KERNEL_FILE} /kernel
COPY --from=disks /${ROOT_FILE} /root.ext4
COPY --from=state /${STATE_FILE} /state-template.ext4
COPY launch.py /opt/humanish/launch.py
LABEL org.opencontainers.image.source="https://github.com/danielgwilson/humanish" \
      to.humanish.runtime.api="1" \
      to.humanish.runtime.revision="${RUNTIME_REVISION}"
