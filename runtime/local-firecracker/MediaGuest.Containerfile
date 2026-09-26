ARG GUEST_IMAGE
FROM ${GUEST_IMAGE}
USER 0:0
COPY media-device.service /etc/systemd/system/humanish-media-device.service
RUN chown 0:0 /etc/systemd/system/humanish-media-device.service \
 && chmod 0444 /etc/systemd/system/humanish-media-device.service \
 && ln -s /etc/systemd/system/humanish-media-device.service /etc/systemd/system/multi-user.target.wants/humanish-media-device.service \
 && mkdir -p /etc/systemd/system/humanish-guest.service.d \
 && printf '[Unit]\nRequires=humanish-media-device.service\nAfter=humanish-media-device.service\n' > /etc/systemd/system/humanish-guest.service.d/media.conf
