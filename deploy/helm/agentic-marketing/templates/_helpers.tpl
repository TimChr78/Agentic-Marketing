{{- define "am.name" -}}{{ .Chart.Name }}{{- end -}}

{{- define "am.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
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

{{- define "am.secretName" -}}{{ .Values.secrets.existingSecret | default (printf "%s-secrets" (include "am.fullname" .)) }}{{- end -}}

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
