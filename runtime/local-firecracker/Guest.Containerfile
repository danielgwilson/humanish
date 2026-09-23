ARG BROWSER_IMAGE=humanish-browser-guest:local
FROM ${BROWSER_IMAGE}
USER 0:0
COPY --from=payload /root/ /
COPY guest-forward.py /opt/humanish/control/guest-forward.py
COPY guest-forward.service /etc/systemd/system/guest-forward.service
# Firecracker exits on guest reboot; poweroff may merely halt a microvm kernel.
RUN ln -s /etc/systemd/system/guest-forward.service /etc/systemd/system/multi-user.target.wants/guest-forward.service \
    && mkdir -p /etc/systemd/system/humanish-guest.service.d \
    && printf '[Unit]\nRequires=guest-forward.service\nAfter=guest-forward.service\nSuccessAction=reboot\nFailureAction=reboot\n' > /etc/systemd/system/humanish-guest.service.d/lifetime.conf \
    && ln -sf /etc/systemd/system/humanish-guest.service /etc/systemd/system/multi-user.target.wants/humanish-guest.service
