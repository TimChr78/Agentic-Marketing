{{- define "am.name" -}}{{ .Chart.Name }}{{- end -}}

{{- define "am.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{/*
A name with a role or hook suffix. am.fullname is already at most 63 characters, so appending to
it can pass Kubernetes's DNS-label limit; truncate the base enough to keep the suffix, so two
resources never collapse onto the same name (#1159). A name that already fits is unchanged.
*/}}
{{- define "am.fullnameFor" -}}
{{- $base := include "am.fullname" .root }}
{{- $name := printf "%s-%s" $base .suffix }}
{{- if gt (len $name) 63 -}}
{{- printf "%s-%s" (trunc (int (sub 62 (len .suffix))) $base | trimSuffix "-") .suffix -}}
{{- else -}}
{{- $name -}}
{{- end -}}
{{- end -}}

{{- define "am.labels" -}}
app.kubernetes.io/name: {{ include "am.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "am.selector" -}}
app.kubernetes.io/name: {{ include "am.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "am.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}

{{- define "am.secretName" -}}{{ .Values.secrets.existingSecret | default (include "am.fullnameFor" (dict "root" . "suffix" "secrets")) }}{{- end -}}

{{- define "am.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ .Values.serviceAccount.name | default (include "am.fullname" .) }}
{{- else -}}{{ .Values.serviceAccount.name | default "default" }}{{- end -}}
{{- end -}}

{{/* Environment shared by every role and the migration job. */}}
{{- define "am.envFrom" -}}
- configMapRef:
    name: {{ include "am.fullname" . }}
- secretRef:
    name: {{ include "am.secretName" . }}
{{- end -}}

{{/*
The replicas a role will actually run: the configured count, or the HPA range when autoscaling is
on. NOTES prints this so a scheduler count is never invented and an autoscaled role is not shown as
a fixed number that the HPA overrides.
*/}}
{{- define "am.roleReplicas" -}}
{{- if and .autoscaling .autoscaling.enabled -}}
autoscaled {{ .autoscaling.minReplicas }}-{{ .autoscaling.maxReplicas }}
{{- else -}}
{{ .replicas }}
{{- end -}}
{{- end -}}
